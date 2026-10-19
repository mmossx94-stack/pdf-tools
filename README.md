# PDF Tools Workspace

แอปพลิเคชันเว็บสำหรับการดู แก้ไข ลบคำ ตรวจจับข้อความ (OCR) และจัดการเอกสาร PDF รองรับฟอนต์ภาษาไทยมาตรฐาน

## โครงสร้างระบบ
- **Frontend**: HTML5, Tailwind CSS, JavaScript (Vanilla), PDF.js (รันผ่าน Apache / XAMPP)
- **Backend**: Python 3.9+, FastAPI, PyMuPDF (fitz), Tesseract OCR (tha+eng)

## ฟีเจอร์หลัก
1. **ดูและจัดการเอกสาร PDF**: แสดงผลเอกสารหลายหน้า รองรับการซูมและจัดหน้า
2. **แก้ไขข้อความ**: เพิ่มกล่องข้อความใหม่ รองรับฟอนต์ไทยมาตรฐาน (TH Sarabun New) จัดขนาดและสีได้
3. **Smart Eraser (ยางลบอัจฉริยะ)**: ลบข้อความหรือส่วนที่ไม่ต้องการ โดยดูดสีพื้นหลังมาระบายทับให้อัตโนมัติ ไม่ทิ้งคราบขาว
4. **Auto OCR (สแกนข้อความ)**: ตรวจจับข้อความในเอกสารสแกนหรือรูปภาพ แปลงเป็นกล่องคำเพื่อแก้ไข
5. **ความปลอดภัย**: ทำงานบน Local / On-premise เอกสารไม่รั่วไหลออกภายนอก

## การติดตั้งและใช้งาน
### Backend
```bash
pip install fastapi uvicorn pymupdf pytesseract pillow pdfplumber
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

### Frontend
นำโฟลเดอร์นี้วางในเว็บเซิร์ฟเวอร์ (เช่น XAMPP `htdocs`) แล้วเปิดผ่านเบราว์เซอร์:
`http://localhost/pdf-tools-app/`
