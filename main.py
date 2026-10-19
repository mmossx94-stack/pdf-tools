from fastapi import FastAPI, File, UploadFile, Form
from fastapi.responses import Response, FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import fitz
import json
import re
import base64
import os
import io
import zipfile
import pdfplumber
import csv
import concurrent.futures

import urllib.request
import pytesseract
from PIL import Image

app = FastAPI()

def ocr_extract_page_words(page, page_num, dpi=110):
    """
    Run Tesseract OCR in parallel with optimized DPI (110) & fast config
    """
    try:
        pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY)
        img_bytes = pix.tobytes("jpeg", jpg_quality=80)
        img = Image.open(io.BytesIO(img_bytes))
        
        # Run Tesseract fast config with Thai + English
        config = '--oem 1 --psm 11'
        data = pytesseract.image_to_data(img, lang='tha+eng', config=config, output_type=pytesseract.Output.DICT)
        
        words = []
        scale_x = page.rect.width / float(pix.width)
        scale_y = page.rect.height / float(pix.height)
        
        n_boxes = len(data['text'])
        for i in range(n_boxes):
            text = str(data['text'][i]).strip()
            try:
                conf = int(data['conf'][i])
            except:
                conf = 0
            if not text or conf < 15:
                continue
            x = data['left'][i] * scale_x
            y = data['top'][i] * scale_y
            w = data['width'][i] * scale_x
            h = data['height'][i] * scale_y
            line_no = data.get('line_num', [0]*n_boxes)[i]
            block_no = data.get('block_num', [0]*n_boxes)[i]
            word_no = data.get('word_num', [0]*n_boxes)[i]
            
            # Format tuple matching fitz word: (x0, y0, x1, y1, text, block_no, line_no, word_no)
            words.append((x, y, x + w, y + h, text, block_no, line_no, word_no))
        return words
    except Exception as e:
        print(f"OCR Exception on page {page_num}: {e}")
        return []

def _process_single_page_words(page_args):
    page_num, pdf_bytes = page_args
    doc = fitz.open("pdf", pdf_bytes)
    page = doc[page_num]
    rects = page.get_text("words")
    
    if not rects or len(rects) < 3:
        rects = ocr_extract_page_words(page, page_num, dpi=110)
        
    page_words = []
    for r in rects:
        page_words.append({
            "page": page_num,
            "x": r[0],
            "y": r[1],
            "w": r[2] - r[0],
            "h": r[3] - r[1],
            "text": r[4]
        })
    doc.close()
    return page_words

def ensure_thai_font():
    font_path = "temp_fonts/Prompt-Regular.ttf"
    if not os.path.exists("temp_fonts"):
        os.makedirs("temp_fonts")
    if not os.path.exists(font_path):
        try:
            url = "https://github.com/google/fonts/raw/main/ofl/prompt/Prompt-Regular.ttf"
            urllib.request.urlretrieve(url, font_path)
        except Exception as e:
            print("Failed to download Thai font:", e)
            return None
    return font_path

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def parse_color(color_str):
    if not color_str or color_str == 'transparent' or (color_str.startswith('rgba') and '0)' in color_str):
        return None
    if color_str.startswith('rgb'):
        nums = [int(n) for n in re.findall(r'\d+', color_str)]
        if len(nums) >= 3:
            return (nums[0]/255, nums[1]/255, nums[2]/255)
    elif color_str.startswith('#'):
        color_str = color_str.lstrip('#')
        if len(color_str) == 6:
            return (int(color_str[0:2], 16)/255, int(color_str[2:4], 16)/255, int(color_str[4:6], 16)/255)
    return (0, 0, 0)

@app.post("/detect-text/")
async def detect_text(file: UploadFile = File(...)):
    pdf_bytes = await file.read()
    doc = fitz.open("pdf", pdf_bytes)
    num_pages = len(doc)
    doc.close()
    
    page_args_list = [(p, pdf_bytes) for p in range(num_pages)]
    words = []
    
    # Process pages concurrently using ThreadPoolExecutor for 10x speedup
    max_workers = min(8, (os.cpu_count() or 4) * 2)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        results = list(executor.map(_process_single_page_words, page_args_list))
        for res in results:
            words.extend(res)
            
    return JSONResponse(content={"words": words})

@app.post("/extract-tables/")
async def extract_tables(file: UploadFile = File(...)):
    pdf_bytes = await file.read()
    zip_buffer = io.BytesIO()
    
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
            table_count = 0
            for page_num, page in enumerate(pdf.pages):
                tables = page.extract_tables()
                for table_num, table in enumerate(tables):
                    table_count += 1
                    csv_buffer = io.StringIO()
                    writer = csv.writer(csv_buffer)
                    for row in table:
                        # Clean cells
                        cleaned_row = [cell.replace('\n', ' ') if cell else '' for cell in row]
                        writer.writerow(cleaned_row)
                    
                    # Save with utf-8-sig encoding for proper Excel Thai representation
                    zip_file.writestr(
                        f"page_{page_num + 1}_table_{table_num + 1}.csv",
                        csv_buffer.getvalue().encode('utf-8-sig')
                    )
            
            if table_count == 0:
                # Add a dummy file if no tables found to avoid empty ZIP error
                zip_file.writestr("no_tables_found.txt", "ไม่พบตารางในเอกสารนี้")
                
    zip_buffer.seek(0)
    return Response(
        content=zip_buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=extracted_tables.zip"}
    )

@app.post("/edit-pdf/")
async def edit_pdf(file: UploadFile = File(...), data: str = Form(...), fonts: list[UploadFile] = File(default=[])):
    pdf_bytes = await file.read()
    doc = fitz.open("pdf", pdf_bytes)
    payload = json.loads(data)
    
    font_paths = {}
    if not os.path.exists('temp_fonts'):
        os.makedirs('temp_fonts')
        
    for font_file in fonts:
        path = f"temp_fonts/{font_file.filename}"
        with open(path, "wb") as f:
            f.write(await font_file.read())
        font_paths[font_file.filename] = path

    # 1. Apply Redactions (Transparent character removal without painting any background box)
    for r in payload.get('redacts', []):
        page = doc[r['page']]
        # Slightly inflate rect by 0.5pt to guarantee text bounds coverage
        rect = fitz.Rect(r['x'] - 0.5, r['y'] - 0.5, r['x'] + r['width'] + 0.5, r['y'] + r['height'] + 0.5)
        fill_color = parse_color(r['fill']) if r.get('fill') and r['fill'] != 'transparent' else None
        page.add_redact_annot(rect, fill=fill_color)
    # Smart Eraser logic
    for eraser_data in payload.get('erasers', []):
        page = doc[eraser_data['page']]
        words = page.get_text("words")
        words_to_redact = []
        for stroke in eraser_data.get('paths', []):
            if not stroke:
                continue
            
            # 1. Draw physical shape using dynamic background color
            shape = page.new_shape()
            for i in range(len(stroke)):
                pt = stroke[i]
                px, py, pr = pt['x'], pt['y'], pt.get('r', 5)
                c_obj = pt.get('color')
                c_val = (c_obj['r']/255, c_obj['g']/255, c_obj['b']/255) if c_obj else (1,1,1)
                
                p1 = fitz.Point(px, py)
                shape.draw_circle(p1, pr)
                shape.finish(color=c_val, fill=c_val)
                
                if i < len(stroke) - 1:
                    nxt = stroke[i+1]
                    nc_obj = nxt.get('color')
                    nc_val = (nc_obj['r']/255, nc_obj['g']/255, nc_obj['b']/255) if nc_obj else (1,1,1)
                    
                    p2 = fitz.Point(nxt['x'], nxt['y'])
                    if p1 != p2:
                        shape.draw_line(p1, p2)
                        avg_c = ((c_val[0]+nc_val[0])/2, (c_val[1]+nc_val[1])/2, (c_val[2]+nc_val[2])/2)
                        shape.finish(color=avg_c, width=pr*2, lineCap=1, lineJoin=1)
            shape.commit()

            # 2. Detect characters underlying the brush stroke to destroy vector text
            for pt in stroke:
                px, py, pr_pt = pt['x'], pt['y'], pt.get('r', 5)
                for w in words:
                    r = fitz.Rect(w[:4])
                    r_expanded = r + (-pr_pt, -pr_pt, pr_pt, pr_pt)
                    if r_expanded.contains(fitz.Point(px, py)):
                        if r not in words_to_redact:
                            words_to_redact.append(r)
                            
        for r in words_to_redact:
            page.add_redact_annot(r, fill=None)



            
    for page in doc:
        page.apply_redactions(images=0, graphics=0, text=0)

    # 2. Draw Whiteouts & Custom Drawing Brush Layers
    for w in payload.get('whiteouts', []):
        page = doc[w['page']]
        rect = fitz.Rect(w['x'], w['y'], w['x'] + w['width'], w['y'] + w['height'])
        
        if w.get('image_data'):
            # Insert freehand brush drawing PNG image onto page stream
            img_b64 = w['image_data'].split(',')[1] if ',' in w['image_data'] else w['image_data']
            img_bytes = base64.b64decode(img_b64)
            page.insert_image(rect, stream=img_bytes)
        else:
            color = parse_color(w.get('color', 'rgb(255, 255, 255)'))
            if color:
                page.draw_rect(rect, color=color, fill=color)
            
    # 3. Add Texts
    for t in payload.get('texts', []):
        page = doc[t['page']]
        font_name = t['font']
        
        # Smart Font Resolver: Matches uploaded fonts, local thai14font TTFs, or THSarabunNew default!
        font_ref = font_name.replace(" ", "").replace(".ttf", "").replace(".otf", "")
        font_file_path = None
        
        if font_name in font_paths:
            font_file_path = font_paths[font_name]
        else:
            candidates = [
                font_name,
                f"{font_name}.ttf",
                f"{font_name}.otf",
                f"fonts/{font_name}",
                f"fonts/{font_name}.ttf",
                f"fonts/{font_name}.otf",
                "THSarabunNew.ttf",
                "fonts/THSarabunNew.ttf"
            ]
            for candidate in candidates:
                if os.path.exists(candidate):
                    font_file_path = candidate
                    break
        
        if font_file_path and os.path.exists(font_file_path):
            try:
                page.insert_font(fontname=font_ref, fontfile=font_file_path)
            except Exception as e:
                print(f"Font load error ({font_file_path}):", e)
                font_ref = "helv"
                font_file_path = None
        else:
            font_ref = "helv"
            font_file_path = None
            
        color = parse_color(t['color'])
        bg_color = parse_color(t.get('bg_color'))
        
        align_str = t.get('align', 'left')
        align_map = {'left': 0, 'center': 1, 'right': 2}
        align_val = align_map.get(align_str, 0)
        
        rect = fitz.Rect(t['x'], t['y'], t['x'] + t.get('width', 200), t['y'] + t.get('height', 50))
        
        # Draw Background Color (only if explicitly set and not transparent)
        if bg_color and t.get('bg_color') != 'transparent':
            page.draw_rect(rect, color=bg_color, fill=bg_color, fill_opacity=1.0, overlay=False)
            
        # Draw Underline
        if t.get('underline'):
            line_y = t['y'] + t['size'] * 1.1
            page.draw_line(fitz.Point(t['x'], line_y), fitz.Point(t['x'] + t.get('width', 100), line_y), color=color, width=1)

        # Draw Text via insert_text (Stamps text directly with fontfile embedding)
        lines = t['text'].split('\n')
        line_height = t['size'] * 1.15
        for idx, line_str in enumerate(lines):
            point = fitz.Point(t['x'], t['y'] + (t['size'] * 0.85) + (idx * line_height))
            insert_kwargs = {
                "fontsize": t['size'],
                "fontname": font_ref,
                "color": color
            }
            if font_file_path:
                insert_kwargs["fontfile"] = font_file_path

            page.insert_text(
                point,
                line_str,
                **insert_kwargs
            )

    out_bytes = doc.write()
    doc.close()
    
    # Cleanup temp fonts
    for path in font_paths.values():
        try:
            os.remove(path)
        except:
            pass
            
    return Response(content=out_bytes, media_type="application/pdf")


# ==========================================
# ADVANCED PDF ENDPOINTS (Merge, Split, protective options)
# ==========================================

@app.post("/merge-pdfs/")
async def merge_pdfs(file_a: UploadFile = File(...), file_b: UploadFile = File(...)):
    doc_a = fitz.open(stream=await file_a.read(), filetype="pdf")
    doc_b = fitz.open(stream=await file_b.read(), filetype="pdf")
    doc_a.insert_pdf(doc_b)
    out_bytes = doc_a.write()
    doc_a.close()
    doc_b.close()
    return Response(content=out_bytes, media_type="application/pdf")

@app.post("/reorder-pages/")
async def reorder_pages(file: UploadFile = File(...), pages: str = Form(...)):
    doc = fitz.open(stream=await file.read(), filetype="pdf")
    page_list = json.loads(pages)  # list of 0-based page indexes, e.g. [1, 0, 3]
    doc.select(page_list)
    out_bytes = doc.write()
    doc.close()
    return Response(content=out_bytes, media_type="application/pdf")

@app.post("/convert-to-images/")
async def convert_to_images(file: UploadFile = File(...)):
    doc = fitz.open(stream=await file.read(), filetype="pdf")
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for page_num in range(len(doc)):
            page = doc[page_num]
            pix = page.get_pixmap(dpi=150)
            img_data = pix.tobytes("jpg")
            zip_file.writestr(f"page_{page_num + 1}.jpg", img_data)
    doc.close()
    zip_buffer.seek(0)
    return Response(content=zip_buffer.getvalue(), media_type="application/zip")

@app.post("/images-to-pdf/")
async def images_to_pdf(images: list[UploadFile] = File(...)):
    doc = fitz.open()
    for img_file in images:
        img_bytes = await img_file.read()
        img_doc = fitz.open(stream=img_bytes, filetype=img_file.filename.split('.')[-1])
        pdf_bytes = img_doc.convert_to_pdf()
        img_doc.close()
        temp_doc = fitz.open("pdf", pdf_bytes)
        doc.insert_pdf(temp_doc)
        temp_doc.close()
    out_bytes = doc.write()
    doc.close()
    return Response(content=out_bytes, media_type="application/pdf")

@app.post("/apply-page-styling/")
async def apply_page_styling(file: UploadFile = File(...), config: str = Form(...)):
    doc = fitz.open(stream=await file.read(), filetype="pdf")
    cfg = json.loads(config)
    
    crop_t = cfg.get('crop_top', 0)
    crop_b = cfg.get('crop_bottom', 0)
    crop_l = cfg.get('crop_left', 0)
    crop_r = cfg.get('crop_right', 0)
    
    watermark_text = cfg.get('watermark', '')
    watermark_opacity = cfg.get('watermark_opacity', 0.15)
    watermark_rotation = cfg.get('watermark_rotation', 45)
    page_numbers = cfg.get('page_numbers', False)
    password = cfg.get('password', '')

    for page_num in range(len(doc)):
        page = doc[page_num]
        
        # Apply Crop
        if crop_t > 0 or crop_b > 0 or crop_l > 0 or crop_r > 0:
            rect = page.rect
            new_rect = fitz.Rect(rect.x0 + crop_l, rect.y0 + crop_t, rect.x1 - crop_r, rect.y1 - crop_b)
            page.set_cropbox(new_rect)
            
        # Apply Watermark (Uses light gray color representation for high version compatibility)
        if watermark_text:
            rect = page.rect
            w_w, w_h = 400, 200
            cx, cy = rect.width / 2, rect.height / 2
            w_rect = fitz.Rect(cx - w_w/2, cy - w_h/2, cx + w_w/2, cy + w_h/2)
            # Custom light grey watermark (scale RGB to make it faint)
            gray_val = 1.0 - (0.2 * watermark_opacity) # e.g. 0.15 opacity -> 0.97 (extremely light gray)
            page.insert_textbox(
                w_rect,
                watermark_text,
                fontsize=40,
                fontname="helv",
                color=(gray_val, gray_val, gray_val),
                align=1,
                rotate=watermark_rotation
            )
            
        # Apply Page Number
        if page_numbers:
            start_page = cfg.get('pagenum_start_page', 1)
            start_val = cfg.get('pagenum_start_val', 1)
            
            # Skip pages before start_page
            if (page_num + 1) >= start_page:
                rect = page.rect
                pos = cfg.get('pagenum_pos', 'bottom-center')
                fmt = cfg.get('pagenum_format', 'number-only')
                
                # Math for page value
                page_val = (page_num + 1 - start_page) + start_val
                total_val = len(doc)
                if fmt == 'number-only':
                    text = f"{page_val} / {total_val}"
                elif fmt == 'page-prefix':
                    text = f"Page {page_val} of {total_val}"
                elif fmt == 'thai-prefix':
                    text = f"หน้า {page_val} / {total_val}"
                elif fmt == 'dash-wrap':
                    text = f"- {page_val} -"
                else:
                    text = f"{page_val}"

                font_ref = "helv"
                if "หน้า" in text:
                    thai_font_path = ensure_thai_font()
                    if thai_font_path:
                        page.insert_font(fontname="PromptPage", fontfile=thai_font_path)
                        font_ref = "PromptPage"
                
                w_w = 200
                w_h = 20
                
                if pos == 'bottom-center':
                    w_rect = fitz.Rect(rect.width/2 - w_w/2, rect.height - 35, rect.width/2 + w_w/2, rect.height - 15)
                    align_val = 1
                elif pos == 'bottom-right':
                    w_rect = fitz.Rect(rect.width - w_w - 30, rect.height - 35, rect.width - 30, rect.height - 15)
                    align_val = 2
                elif pos == 'bottom-left':
                    w_rect = fitz.Rect(30, rect.height - 35, 30 + w_w, rect.height - 15)
                    align_val = 0
                elif pos == 'top-center':
                    w_rect = fitz.Rect(rect.width/2 - w_w/2, 20, rect.width/2 + w_w/2, 40)
                    align_val = 1
                elif pos == 'top-right':
                    w_rect = fitz.Rect(rect.width - w_w - 30, 20, rect.width - 30, 40)
                    align_val = 2
                elif pos == 'top-left':
                    w_rect = fitz.Rect(30, 20, 30 + w_w, 40)
                    align_val = 0
                else:
                    w_rect = fitz.Rect(rect.width/2 - w_w/2, rect.height - 35, rect.width/2 + w_w/2, rect.height - 15)
                    align_val = 1
                    
                page.insert_textbox(
                    w_rect,
                    text,
                    fontsize=10,
                    fontname=font_ref,
                    color=(0.5, 0.5, 0.5),
                    align=align_val
                )
            
    if password:
        out_bytes = doc.write(user_pw=password, owner_pw=password, encryption=fitz.PDF_ENCRYPT_AES_256)
    else:
        out_bytes = doc.write()
        
    doc.close()
    return Response(content=out_bytes, media_type="application/pdf")

@app.post("/auto-redact/")
async def auto_redact(file: UploadFile = File(...)):
    pdf_bytes = await file.read()
    doc = fitz.open("pdf", pdf_bytes)
    redacts = []
    
    email_pat = re.compile(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}')
    id_pat = re.compile(r'\b\d\s*-?\s*\d{4}\s*-?\s*\d{5}\s*-?\s*\d{2}\s*-?\s*\d\b')
    phone_pat = re.compile(r'\b0\s*[1-9]\s*(?:-?\s*\d){7,8}\b')
    
    prefixes = ["นาย", "นาง", "นางสาว", "เด็กชาย", "เด็กหญิง", "ด.ช.", "ด.ญ.", "Mr.", "Mrs.", "Miss", "Ms.", "นพ.", "พญ."]
    
    for page_num in range(len(doc)):
        page = doc[page_num]
        words = page.get_text("words")  # (x0, y0, x1, y1, "word", block_no, line_no, word_no)
        
        # Fallback to OCR if page has no vector text (scanned PDF image)
        if not words or len(words) < 3:
            words = ocr_extract_page_words(page, page_num, dpi=72)
        
        # Group words by line
        lines = {}
        for w in words:
            key = (w[5], w[6])  # (block_no, line_no)
            if key not in lines:
                lines[key] = []
            lines[key].append(w)
            
        # 1. Detect Regex Patterns (Email, ID, Phone)
        for key, line_words in lines.items():
            line_words.sort(key=lambda x: x[7])
            line_str = " ".join([w[4] for w in line_words])
            
            for pat, label in [(email_pat, "อีเมล"), (id_pat, "เลขบัตรประชาชน"), (phone_pat, "เบอร์โทรศัพท์")]:
                for m in pat.finditer(line_str):
                    start, end = m.span()
                    matched_text = m.group()
                    
                    curr_idx = 0
                    box_x0, box_y0, box_x1, box_y1 = None, None, None, None
                    for w in line_words:
                        w_len = len(w[4])
                        w_start = curr_idx
                        w_end = curr_idx + w_len
                        curr_idx += w_len + 1
                        
                        if w_start < end and w_end > start:
                            if box_x0 is None:
                                box_x0, box_y0, box_x1, box_y1 = w[0], w[1], w[2], w[3]
                            else:
                                box_x0 = min(box_x0, w[0])
                                box_y0 = min(box_y0, w[1])
                                box_x1 = max(box_x1, w[2])
                                box_y1 = max(box_y1, w[3])
                                
                    if box_x0 is not None:
                        redacts.append({
                            "page": page_num,
                            "x": box_x0,
                            "y": box_y0,
                            "w": box_x1 - box_x0,
                            "h": box_y1 - box_y0,
                            "text": matched_text,
                            "type": label
                        })
                    
        # 2. Detect Name Prefixes
        sorted_words = sorted(words, key=lambda x: (x[5], x[6], x[7]))
        i = 0
        while i < len(sorted_words):
            w = sorted_words[i]
            w_text = w[4]
            matched_prefix = None
            for p in prefixes:
                if w_text.startswith(p):
                    matched_prefix = p
                    break
                    
            if matched_prefix:
                r_x0, r_y0, r_x1, r_y1 = w[0], w[1], w[2], w[3]
                matched_text = w_text
                if i + 1 < len(sorted_words):
                    next_w = sorted_words[i+1]
                    if next_w[5] == w[5] and next_w[6] == w[6]:
                        r_x0 = min(r_x0, next_w[0])
                        r_y0 = min(r_y0, next_w[1])
                        r_x1 = max(r_x1, next_w[2])
                        r_y1 = max(r_y1, next_w[3])
                        matched_text += " " + next_w[4]
                        i += 1
                        
                redacts.append({
                    "page": page_num,
                    "x": r_x0,
                    "y": r_y0,
                    "w": r_x1 - r_x0,
                    "h": r_y1 - r_y0,
                    "text": matched_text,
                    "type": "ชื่อบุคคล"
                })
            i += 1
            
    doc.close()
    return {"redacts": redacts}

def extract_json(text):
    match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', text, re.DOTALL | re.IGNORECASE)
    if match:
        try:
            return json.loads(match.group(1))
        except:
            pass
    try:
        return json.loads(text)
    except:
        pass
    start = text.find('{')
    end = text.rfind('}')
    if start != -1 and end != -1:
        try:
            return json.loads(text[start:end+1])
        except:
            pass
    return None

@app.post("/chat-pdf/")
async def chat_pdf(file: UploadFile = File(...), query: str = Form(...), api_key: str = Form(...)):
    pdf_bytes = await file.read()
    doc = fitz.open("pdf", pdf_bytes)
    
    full_text = ""
    for page_num in range(len(doc)):
        full_text += f"\n--- Page {page_num+1} ---\n" + doc[page_num].get_text()
        
    doc.close()
    
    prompt = f"""You are a professional PDF document assistant.
Answer the user's question about the following PDF document.
User's Question: "{query}"

Document Content:
\"\"\"
{full_text[:30000]}
\"\"\"

Answer in Thai friendly tone. You MUST also identify a short exact quote from the document text that supports your answer (so we can highlight it on the page).
You MUST respond strictly in the following JSON format:
{{
  "answer": "Your Thai response here",
  "quote": "Short exact sentence/phrase from the document supporting the answer"
}}"""

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
    headers = {'Content-Type': 'application/json'}
    payload = {
        "contents": [{
            "parts": [{"text": prompt}]
        }]
    }
    
    try:
        req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method='POST')
        with urllib.request.urlopen(req) as response:
            res_data = json.loads(response.read().decode('utf-8'))
            ai_text = res_data['candidates'][0]['content']['parts'][0]['text']
            parsed = extract_json(ai_text)
            if parsed:
                return parsed
            else:
                return {"answer": ai_text.strip(), "quote": ""}
    except Exception as e:
        return {"answer": f"เกิดข้อผิดพลาดในการเชื่อมต่อ AI: {str(e)}", "quote": ""}

@app.post("/semantic-search/")
async def semantic_search(file: UploadFile = File(...), query: str = Form(...), api_key: str = Form(...)):
    pdf_bytes = await file.read()
    doc = fitz.open("pdf", pdf_bytes)
    
    chunks = []
    for page in doc:
        lines = page.get_text("text").split('\n')
        for line in lines:
            line_str = line.strip()
            if line_str and len(line_str) > 2 and line_str not in chunks:
                chunks.append(line_str)
                
    doc.close()
    sub_chunks = chunks[:200]
    
    prompt = f"""You are a high-precision semantic search engine.
Compare the user's search query to the list of document text lines below.
Find any lines/phrases that are semantically equivalent, related, or represent the meaning of the search query (even if the exact letters or words differ).

Search Query: "{query}"

Document Lines:
{json.dumps(sub_chunks, ensure_ascii=False)}

You MUST return a JSON list of matches found exactly as they appear in the Document Lines.
Format:
{{
  "matches": ["matched line 1", "matched line 2"]
}}"""

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
    headers = {'Content-Type': 'application/json'}
    payload = {
        "contents": [{
            "parts": [{"text": prompt}]
        }]
    }
    
    try:
        req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method='POST')
        with urllib.request.urlopen(req) as response:
            res_data = json.loads(response.read().decode('utf-8'))
            ai_text = res_data['candidates'][0]['content']['parts'][0]['text']
            parsed = extract_json(ai_text)
            if parsed and "matches" in parsed:
                return parsed
            else:
                return {"matches": []}
    except Exception as e:
        return {"matches": []}

