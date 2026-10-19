const API_BASE = 'http://10.5.6.78:8000';
const uploadInput = document.getElementById('upload-pdf');
const downloadBtn = document.getElementById('download-btn');
const toolbar = document.getElementById('floating-tool-dock');
const leftSidebar = document.getElementById('left-sidebar');
const placeholder = document.getElementById('placeholder');
const pdfContainer = document.getElementById('pdf-container');

const fontFamilySelect = document.getElementById('font-family');
if (fontFamilySelect) fontFamilySelect.value = 'THSarabunNew.ttf';

const fontSizeInput = document.getElementById('font-size');
const fontColorInput = document.getElementById('font-color');
const highlightColorInput = document.getElementById('highlight-color');
const btnUnderline = document.getElementById('btn-underline');
const alignBtns = ['left', 'center', 'right'].map(a => document.getElementById(`btn-align-${a}`));
const toolBtns = document.querySelectorAll('.tool-btn');
const toolHint = document.getElementById('tool-hint');
const textToolbar = document.getElementById('text-toolbar');
const whiteoutToolbar = document.getElementById('whiteout-toolbar');

// Typography controls
const letterSpacingInput = document.getElementById('letter-spacing');
const valLetterSpacing = document.getElementById('val-letter-spacing');
const lineHeightInput = document.getElementById('line-height');
const valLineHeight = document.getElementById('val-line-height');
const btnCaseNone = document.getElementById('btn-case-none');
const btnCaseUpper = document.getElementById('btn-case-upper');
const btnCaseLower = document.getElementById('btn-case-lower');

if (letterSpacingInput) {
    letterSpacingInput.addEventListener('input', (e) => {
        const val = e.target.value;
        if (valLetterSpacing) valLetterSpacing.innerText = val + 'px';
        if (window.activeTextBox) {
            window.activeTextBox.style.letterSpacing = val + 'px';
            saveState();
        }
    });
}

if (lineHeightInput) {
    lineHeightInput.addEventListener('input', (e) => {
        const val = e.target.value;
        if (valLineHeight) valLineHeight.innerText = val + 'x';
        if (window.activeTextBox) {
            window.activeTextBox.style.lineHeight = val;
            saveState();
        }
    });
}

if (btnCaseNone) {
    btnCaseNone.addEventListener('click', () => {
        if (window.activeTextBox) {
            window.activeTextBox.style.textTransform = 'none';
            saveState();
        }
    });
}
if (btnCaseUpper) {
    btnCaseUpper.addEventListener('click', () => {
        if (window.activeTextBox) {
            window.activeTextBox.style.textTransform = 'uppercase';
            saveState();
        }
    });
}
if (btnCaseLower) {
    btnCaseLower.addEventListener('click', () => {
        if (window.activeTextBox) {
            window.activeTextBox.style.textTransform = 'lowercase';
            saveState();
        }
    });
}

let currentPdfBytes = null;
let pdfDocJs = null;
let currentMode = 'text';
let isBrushing = false;
let currentBrushStroke = [];
let allErasers = [];
let brushRadius = 8;

window.activeSelection = null;

function selectElement(el) {
    document.querySelectorAll('.selected-box').forEach(x => x.classList.remove('selected-box'));
    if (el) {
        el.classList.add('selected-box');
        window.activeSelection = el;
        if (el.classList.contains('text-overlay')) {
            window.activeTextBox = el;
            updateToolbarUI(el);
        }
    } else {
        window.activeSelection = null;
        window.activeTextBox = null;
    }
}

let isDrawing = false;
let startX = 0;
let startY = 0;
let activeDrawingBox = null;

let stateHistory = [];
let currentStateIndex = -1;
let isRestoring = false;

function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

function saveState() {
    if (isRestoring || !pdfDocJs) return;
    
    const state = [];
    document.querySelectorAll('.page-container').forEach(pageDiv => {
        const pageState = { erasers: JSON.parse(JSON.stringify(allErasers.find(p => p.page === parseInt(pageDiv.dataset.pageIndex)) || { page: parseInt(pageDiv.dataset.pageIndex), paths: [] })),  pageIndex: pageDiv.dataset.pageIndex, items: [] };
        
        pageDiv.querySelectorAll('.text-overlay, .whiteout-box, .word-overlay').forEach(el => {
            if (el.classList.contains('text-overlay')) {
                pageState.items.push({
                    type: 'text',
                    id: el.id || generateId(),
                    left: el.style.left, top: el.style.top,
                    width: el.style.width, height: el.style.height,
                    text: (() => { let b = el.querySelector('.text-box-del-btn'); if(b) b.remove(); let t = el.innerText; if(b) el.appendChild(b); return t; })(),
                    fontFamily: el.style.fontFamily, fontSize: el.style.fontSize,
                    color: el.style.color, fontWeight: el.style.fontWeight, fontStyle: el.style.fontStyle, textDecoration: el.style.textDecoration, textAlign: el.style.textAlign, backgroundColor: el.style.backgroundColor,
                    sourceRedactId: el.dataset.sourceRedactId
                });
                if(!el.id) el.id = pageState.items[pageState.items.length-1].id;
            } else if (el.classList.contains('whiteout-box')) {
                pageState.items.push({
                    type: 'whiteout',
                    id: el.id || generateId(),
                    left: el.style.left, top: el.style.top,
                    width: el.style.width, height: el.style.height,
                    backgroundColor: el.style.backgroundColor
                });
                if(!el.id) el.id = pageState.items[pageState.items.length-1].id;
            } else if (el.classList.contains('word-overlay')) {
                pageState.items.push({
                    type: 'word',
                    id: el.id,
                    isHidden: el.classList.contains('hidden'),
                    isRedacted: el.classList.contains('redact-target'),
                    origX: el.dataset.origX,
                    origY: el.dataset.origY,
                    origW: el.dataset.origW,
                    origH: el.dataset.origH
                });
            }
        });
        state.push(pageState);
    });
    
    const stateStr = JSON.stringify(state);
    if (currentStateIndex >= 0 && stateHistory[currentStateIndex] === stateStr) return;
    
    if (currentStateIndex < stateHistory.length - 1) {
        stateHistory = stateHistory.slice(0, currentStateIndex + 1);
    }
    
    stateHistory.push(stateStr);
    currentStateIndex++;
    updateHistoryUI();
}

function updateHistoryUI() {
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if(undoBtn) undoBtn.disabled = currentStateIndex <= 0;
    if(redoBtn) redoBtn.disabled = currentStateIndex >= stateHistory.length - 1;
}

function restoreState(index) {
    if (index < 0 || index >= stateHistory.length) return;
    isRestoring = true;
    currentStateIndex = index;
    const state = JSON.parse(stateHistory[index]);
    
    state.forEach(pageState => {
        const pageDiv = document.querySelector(`.page-container[data-page-index="${pageState.pageIndex}"]`);
        if (!pageDiv) return;
        
        pageDiv.querySelectorAll('.text-overlay, .whiteout-box').forEach(el => el.remove());
        
        let pErasers = allErasers.find(p => p.page === pageState.pageIndex);
        if (!pErasers) {
            pErasers = { page: pageState.pageIndex, paths: [] };
            allErasers.push(pErasers);
        }
        pErasers.paths = pageState.erasers ? JSON.parse(JSON.stringify(pageState.erasers.paths)) : [];
        
        const canvas = pageDiv.querySelector('canvas');
        if (canvas && canvas.originalCanvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(canvas.originalCanvas, 0, 0);
            
            pErasers.paths.forEach(path => {
                path.forEach(pt => {
                    const cx = pt[0];
                    const cy = pt[1];
                    const cr = pt[2];
                    
                    const ix = Math.max(0, Math.floor(cx - cr));
                    const iy = Math.max(0, Math.floor(cy - cr));
                    const iw = Math.min(canvas.width - ix, Math.ceil(cr * 2 + 2));
                    const ih = Math.min(canvas.height - iy, Math.ceil(cr * 2 + 2));
                    if (iw <= 0 || ih <= 0) return;
                    
                    const sampleImg = ctx.getImageData(ix, iy, iw, ih).data;
                    let lumList = [];
                    for (let i = 0; i < sampleImg.length; i += 4) {
                        lumList.push({
                            r: sampleImg[i], g: sampleImg[i+1], b: sampleImg[i+2],
                            lum: 0.299 * sampleImg[i] + 0.587 * sampleImg[i+1] + 0.114 * sampleImg[i+2]
                        });
                    }
                    lumList.sort((a, b) => b.lum - a.lum);
                    let topCount = Math.max(1, Math.floor(lumList.length * 0.2));
                    let rSum = 0, gSum = 0, bSum = 0;
                    for (let i = 0; i < topCount; i++) {
                        rSum += lumList[i].r; gSum += lumList[i].g; bSum += lumList[i].b;
                    }
                    const bgR = rSum / topCount;
                    const bgG = gSum / topCount;
                    const bgB = bSum / topCount;
                    const bgLum = lumList[0].lum;
                    
                    const imgData = ctx.getImageData(ix, iy, iw, ih);
                    const data = imgData.data;
                    
                    for (let py = 0; py < ih; py++) {
                        for (let px = 0; px < iw; px++) {
                            const dx = (px + ix) - cx;
                            const dy = (py + iy) - cy;
                            if (dx*dx + dy*dy <= cr*cr) {
                                const i = (py * iw + px) * 4;
                                const lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
                                if (lum < bgLum - 20) {
                                    data[i] = bgR; data[i+1] = bgG; data[i+2] = bgB;
                                }
                            }
                        }
                    }
                    ctx.putImageData(imgData, ix, iy);
                });
            });
        }
        
        pageState.items.forEach(item => {
            if (item.type === 'text') {
                const div = document.createElement('div');
                div.className = 'text-overlay cursor-text';
                div.id = item.id;
                div.contentEditable = true;
                div.style.left = item.left;
                div.style.top = item.top;
                div.style.width = item.width;
                div.style.height = item.height;
                div.style.fontFamily = item.fontFamily;
                div.style.fontSize = item.fontSize;
                div.style.color = item.color;
                div.style.fontWeight = item.fontWeight;
                div.style.fontStyle = item.fontStyle;
                if(item.textDecoration) div.style.textDecoration = item.textDecoration;
                if(item.textAlign) div.style.textAlign = item.textAlign;
                if(item.backgroundColor && item.backgroundColor !== 'rgba(255, 255, 255, 0.6)') div.style.backgroundColor = item.backgroundColor;
                div.innerText = item.text;
                if (item.sourceRedactId) div.dataset.sourceRedactId = item.sourceRedactId;
                
                makeDraggable(div, pageDiv);
                attachDeleteButton(div);
                
                div.addEventListener('mousedown', (e) => {
                    selectElement(div);
                });
                
                div.addEventListener('focus', () => {
                    window.activeTextBox = div;
                    updateToolbarUI(div);
                });
                
                div.addEventListener('blur', () => {
                    div.contentEditable = false;
                    div.classList.add('cursor-move');
                    div.classList.remove('cursor-text');
                    if (!div.innerText.trim()) {
                        div.remove();
                        if(window.activeTextBox === div) window.activeTextBox = null;
                        
                        if (div.dataset.sourceRedactId) {
                            const purpleBox = document.getElementById(div.dataset.sourceRedactId);
                            if (purpleBox) {
                                purpleBox.classList.remove('hidden');
                                purpleBox.style.backgroundColor = 'rgba(239, 68, 68, 0.3)'; 
                                purpleBox.style.borderColor = 'red';
                                purpleBox.style.backgroundImage = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'100%25\' height=\'100%25\'%3E%3Cline x1=\'0\' y1=\'0\' x2=\'100%25\' y2=\'100%25\' stroke=\'red\' stroke-width=\'2\'/%3E%3Cline x1=\'100%25\' y1=\'0\' x2=\'0\' y2=\'100%25\' stroke=\'red\' stroke-width=\'2\'/%3E%3C/svg%3E")';
                                purpleBox.title = 'คำนี้ถูกลบทิ้งแล้ว (จะหายไปเมื่อกดบันทึก PDF)';
                            }
                        }
                    } else {
                        // บังคับให้พื้นหลังข้อความโปร่งใสเสมอเมื่อพิมพ์เสร็จ
                        div.style.backgroundColor = 'transparent';
                        div.style.backdropFilter = 'none';
                    }
                    saveState();
                });
                
                pageDiv.appendChild(div);
            } else if (item.type === 'whiteout') {
                const div = document.createElement('div');
                div.className = 'whiteout-box cursor-move';
                div.id = item.id;
                div.style.left = item.left;
                div.style.top = item.top;
                div.style.width = item.width;
                div.style.height = item.height;
                div.style.backgroundColor = item.backgroundColor;
                
                makeDraggable(div, pageDiv);
                attachDeleteButton(div);
                
                div.addEventListener('mousedown', (e) => {
                    selectElement(div);
                });
                
                div.addEventListener('dblclick', () => { div.remove(); saveState(); });
                pageDiv.appendChild(div);
            } else if (item.type === 'word') {
                const el = document.getElementById(item.id);
                if (el) {
                    if (item.isHidden) {
                        el.classList.add('hidden');
                    } else {
                        el.classList.remove('hidden');
                    }
                    
                    if (item.isRedacted) {
                        el.classList.add('redact-target');
                        el.dataset.origX = item.origX;
                        el.dataset.origY = item.origY;
                        el.dataset.origW = item.origW;
                        el.dataset.origH = item.origH;
                        
                        el.style.backgroundColor = '#ffffff';
                        el.style.borderColor = 'transparent';
                        el.style.borderStyle = 'none';
                        el.style.backgroundImage = 'none';
                        const delBtn = el.querySelector('.word-delete-btn');
                        if (delBtn) delBtn.style.display = 'none';
                    } else {
                        el.classList.remove('redact-target');
                        el.style.backgroundColor = 'transparent';
                        el.style.borderColor = 'transparent';
                        el.style.borderStyle = 'dashed';
                        el.style.backgroundImage = 'none';
                        const delBtn = el.querySelector('.word-delete-btn');
                        if (delBtn) delBtn.style.display = 'block';
                    }
                }
            }
        });
    });
    
    updateHistoryUI();
    isRestoring = false;
}

function deleteSelectedBox(el) {
    if (!el) el = window.activeSelection || window.activeTextBox;
    if (!el) return;

    if (el.classList.contains('text-overlay')) {
        if (el.dataset.sourceRedactId) {
            const purpleBox = document.getElementById(el.dataset.sourceRedactId);
            if (purpleBox) {
                purpleBox.classList.add('redact-target');
                purpleBox.classList.remove('hidden');
                purpleBox.style.backgroundColor = 'transparent';
                purpleBox.style.borderColor = 'transparent';
                purpleBox.style.backgroundImage = 'none';
                purpleBox.title = 'คำนี้ถูกลบทิ้งแล้ว (วนเมาส์เพื่อคลิกกู้คืน)';
            }
        }
        el.remove();
    } else if (el.classList.contains('whiteout-box')) {
        el.remove();
    }

    if (window.activeSelection === el) window.activeSelection = null;
    if (window.activeTextBox === el) window.activeTextBox = null;
    saveState();
}

document.getElementById('btn-undo').addEventListener('click', () => restoreState(currentStateIndex - 1));
document.getElementById('btn-redo').addEventListener('click', () => restoreState(currentStateIndex + 1));
document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
            restoreState(currentStateIndex + 1);
        } else {
            restoreState(currentStateIndex - 1);
        }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        restoreState(currentStateIndex + 1);
    }
    
    // Backspace / Delete logic for selections & text boxes
    if (e.key === 'Backspace' || e.key === 'Delete') {
        const active = document.activeElement;
        
        // Skip if user is typing in regular form controls
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
            return;
        }

        // If user is inside a text box and it is empty
        if (active && active.classList.contains('text-overlay') && active.isContentEditable) {
            if (!active.innerText.trim() || active.innerText === '\n') {
                e.preventDefault();
                deleteSelectedBox(active);
                return;
            }
        }

        // If a box is selected or active (and user is not currently typing inside contentEditable text)
        if (window.activeSelection || window.activeTextBox) {
            const targetEl = window.activeSelection || window.activeTextBox;
            if (!targetEl.isContentEditable || active !== targetEl || !targetEl.innerText.trim()) {
                e.preventDefault();
                deleteSelectedBox(targetEl);
            }
        }
    }
});

function setupDrawingCanvas(pageDiv, canvasWidth, canvasHeight) {
    let drawCanvas = pageDiv.querySelector('.drawing-layer-canvas');
    if (!drawCanvas) {
        drawCanvas = document.createElement('canvas');
        drawCanvas.className = 'drawing-layer-canvas absolute inset-0 pointer-events-none z-20';
        drawCanvas.width = canvasWidth;
        drawCanvas.height = canvasHeight;
        pageDiv.appendChild(drawCanvas);
    }
    
    const ctx = drawCanvas.getContext('2d');
    let drawing = false;
    let lastX = 0, lastY = 0;

    const startDrawing = (e) => {
        if (currentMode !== 'draw-brush') return;
        drawing = true;
        const rect = drawCanvas.getBoundingClientRect();
        lastX = e.clientX - rect.left;
        lastY = e.clientY - rect.top;
        drawCanvas.setPointerCapture(e.pointerId);
    };

    const draw = (e) => {
        if (!drawing || currentMode !== 'draw-brush') return;
        const rect = drawCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(x, y);

        if (currentBrushType === 'highlighter') {
            ctx.globalAlpha = 0.35;
            ctx.strokeStyle = currentBrushColor;
            ctx.lineWidth = currentBrushSize * 2.5;
            ctx.lineCap = 'square';
            ctx.lineJoin = 'bevel';
        } else {
            ctx.globalAlpha = 1.0;
            ctx.strokeStyle = currentBrushColor;
            ctx.lineWidth = currentBrushSize;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
        }

        ctx.stroke();
        ctx.globalAlpha = 1.0;

        lastX = x;
        lastY = y;
    };

    const stopDrawing = (e) => {
        if (drawing) {
            drawing = false;
            saveState();
        }
    };

    drawCanvas.addEventListener('pointerdown', startDrawing);
    drawCanvas.addEventListener('pointermove', draw);
    drawCanvas.addEventListener('pointerup', stopDrawing);
    drawCanvas.addEventListener('pointercancel', stopDrawing);
}

toolBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        const targetBtn = e.currentTarget;
        currentMode = targetBtn.dataset.mode;
        
        document.getElementById('pdf-container').style.cursor = '';
        toolBtns.forEach(b => b.classList.remove('active'));
        targetBtn.classList.add('active');
        
        document.querySelectorAll('.word-overlay, .text-overlay').forEach(el => el.style.pointerEvents = (currentMode === 'eraser' || currentMode === 'draw-brush') ? 'none' : 'auto');
        const brushBar = document.getElementById('drawing-brush-toolbar');
        if (currentMode === 'draw-brush') {
            pdfContainer.className = 'tool-brush relative w-full flex flex-col items-center pb-20 cursor-crosshair';
            if (brushBar) brushBar.classList.remove('hidden');
            document.querySelectorAll('.drawing-layer-canvas').forEach(c => c.style.pointerEvents = 'auto');
        } else {
            if (brushBar) brushBar.classList.add('hidden');
            document.querySelectorAll('.drawing-layer-canvas').forEach(c => c.style.pointerEvents = 'none');
            
            if(currentMode === 'select') {
                pdfContainer.className = 'relative w-full flex flex-col items-center pb-20 cursor-default';
                textToolbar.classList.remove('hidden');
                whiteoutToolbar.classList.add('hidden');
                if(document.getElementById('eraser-toolbar')) document.getElementById('eraser-toolbar').classList.add('hidden');
            } else if(currentMode === 'text') {
                pdfContainer.className = 'tool-text relative w-full flex flex-col items-center pb-20 cursor-text';
                textToolbar.classList.remove('hidden');
                whiteoutToolbar.classList.add('hidden');
                if(document.getElementById('eraser-toolbar')) document.getElementById('eraser-toolbar').classList.add('hidden');
            } else if(currentMode === 'eraser') {
                pdfContainer.className = 'tool-eraser relative w-full flex flex-col items-center pb-20';
                if(typeof updateEraserCursor === 'function') updateEraserCursor();
                textToolbar.classList.add('hidden');
                whiteoutToolbar.classList.add('hidden');
                if(document.getElementById('eraser-toolbar')) document.getElementById('eraser-toolbar').classList.remove('hidden');
            } else {
                pdfContainer.className = 'tool-whiteout relative w-full flex flex-col items-center pb-20 cursor-crosshair';
                textToolbar.classList.add('hidden');
                whiteoutToolbar.classList.remove('hidden');
                if(document.getElementById('eraser-toolbar')) document.getElementById('eraser-toolbar').classList.add('hidden');
            }
        }
    });
});

let currentBrushType = 'pen';
let currentBrushColor = '#ef4444';
let currentBrushSize = 4;

// Brush type toggle
document.querySelectorAll('.brush-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.brush-type-btn').forEach(b => {
            b.classList.remove('bg-indigo-600', 'text-white', 'shadow-sm');
            b.classList.add('text-slate-600');
        });
        btn.classList.add('bg-indigo-600', 'text-white', 'shadow-sm');
        btn.classList.remove('text-slate-600');
        currentBrushType = btn.dataset.type;
    });
});

// Brush size slider
const brushSizeInput = document.getElementById('brush-size');
const brushSizeVal = document.getElementById('brush-size-val');
if (brushSizeInput) {
    brushSizeInput.addEventListener('input', (e) => {
        currentBrushSize = parseInt(e.target.value);
        if (brushSizeVal) brushSizeVal.innerText = currentBrushSize + 'px';
    });
}

// Brush color dots & picker
const brushColorInput = document.getElementById('brush-color');
document.querySelectorAll('.brush-color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
        currentBrushColor = dot.dataset.color;
        if (brushColorInput) brushColorInput.value = currentBrushColor;
    });
});
if (brushColorInput) {
    brushColorInput.addEventListener('input', (e) => {
        currentBrushColor = e.target.value;
    });
}



uploadInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
        const arrayBuffer = await file.arrayBuffer();
        currentPdfBytes = new Uint8Array(arrayBuffer);
        
        placeholder.classList.add('hidden');
        pdfContainer.classList.remove('hidden');
        toolbar.classList.remove('hidden');
        if (leftSidebar) {
            leftSidebar.classList.remove('hidden');
            document.body.classList.add('left-sidebar-open');
        }
        downloadBtn.classList.remove('hidden');
        const headerUploadBtn = document.getElementById('header-upload-btn');
        if (headerUploadBtn) headerUploadBtn.classList.remove('hidden');
        
        // Show scan prompt banner and pulse the scan button
        const banner = document.getElementById('scan-prompt-banner');
        if (banner) banner.classList.remove('hidden');
        
        const scanBtn = document.getElementById('btn-smart-scan');
        if (scanBtn) {
            scanBtn.classList.remove('hidden');
            scanBtn.classList.add('pulse-purple-btn');
        }
        
        const toolsBtn = document.getElementById('btn-open-tools');
        if (toolsBtn) toolsBtn.classList.remove('hidden');
        
        pdfContainer.innerHTML = ''; // clear old pages
        
        await renderPDF(currentPdfBytes);
        
        // Remove auto-scan per user request

    }
});

// ── Re-render on window resize (debounced 250ms) ────────────────────────────
let _resizeTimer = null;
window.addEventListener('resize', () => {
    if (!currentPdfBytes) return;
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
        pdfContainer.innerHTML = '';
        renderPDF(currentPdfBytes);
    }, 250);
});
// ────────────────────────────────────────────────────────────────────────────

function bulkRedactWordsInBox(pageDiv, x0, y0, x1, y1) {
    let changed = false;
    pageDiv.querySelectorAll('.word-overlay').forEach(div => {
        const left = parseFloat(div.style.left);
        const top = parseFloat(div.style.top);
        const right = left + parseFloat(div.style.width);
        const bottom = top + parseFloat(div.style.height);
        
        const intersects = !(right < x0 || left > x1 || bottom < y0 || top > y1);
        if (intersects && !div.classList.contains('redact-target')) {
            redactWordDirectly(div);
            changed = true;
        }
    });
    
    if (changed) {
        saveState();
        document.querySelector('[data-mode="select"]').click();
    }
}

function eraseWordPixelsFromCanvas(pageDiv, x, y, w, h, targetDiv = null) {
    try {
        const canvas = pageDiv.querySelector('canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const ix = Math.max(0, Math.floor(x - 1));
        const iy = Math.max(0, Math.floor(y - 1));
        const iw = Math.min(canvas.width - ix, Math.ceil(w + 2));
        const ih = Math.min(canvas.height - iy, Math.ceil(h + 2));

        if (iw <= 0 || ih <= 0) return;

        // 1. Sample surrounding paper background color
        const sampleX = Math.max(0, ix - 12);
        const sampleY = Math.max(0, iy - 12);
        const sampleW = Math.min(24, canvas.width - sampleX);
        const sampleH = Math.min(24, canvas.height - sampleY);
        
        const sampleImg = ctx.getImageData(sampleX, sampleY, sampleW, sampleH).data;

        let rSum = 0, gSum = 0, bSum = 0, count = 0;
        for (let i = 0; i < sampleImg.length; i += 4) {
            const r = sampleImg[i];
            const g = sampleImg[i + 1];
            const b = sampleImg[i + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            if (lum > 180) {
                rSum += r; gSum += g; bSum += b; count++;
            }
        }

        let bgR = 255, bgG = 255, bgB = 255;
        if (count > 0) {
            bgR = Math.round(rSum / count);
            bgG = Math.round(gSum / count);
            bgB = Math.round(bSum / count);
        }

        if (targetDiv) {
            targetDiv.dataset.paperColor = `rgb(${bgR}, ${bgG}, ${bgB})`;
        }

        // 2. Selective Character Glyph Erase: Detect & replace ONLY character ink pixels (lum < 200), background stays 100% untouched!
        const targetImgData = ctx.getImageData(ix, iy, iw, ih);
        const data = targetImgData.data;

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;

            // Target character ink pixels including anti-aliased edges (lum < 200)
            if (lum < 200) {
                data[i] = bgR;
                data[i + 1] = bgG;
                data[i + 2] = bgB;
                data[i + 3] = 255;
            }
        }

        // Put image data back — background pixels remain 100% untouched!
        ctx.putImageData(targetImgData, ix, iy);
    } catch(e) {
        console.error("Canvas erase error:", e);
    }
}

function redactWordDirectly(div) {
    div.classList.add('redact-target');
    div.dataset.origX = div.dataset.x;
    div.dataset.origY = div.dataset.y;
    div.dataset.origW = div.dataset.w;
    div.dataset.origH = div.dataset.h;
    if (!div.id) div.id = 'redact-' + Math.random().toString(36).substr(2, 9);
    
    div.style.backgroundColor = 'transparent';
    div.style.borderColor = 'transparent';
    div.style.borderStyle = 'none';
    div.style.backgroundImage = 'none';
    div.title = 'คำนี้ถูกลบทิ้งแล้ว (วนเมาส์เพื่อคลิกกู้คืน)';

    const pageDiv = div.closest('.page-container');
    if (pageDiv && div.dataset.x) {
        const scale = parseFloat(pageDiv.dataset.scale || 1.5);
        eraseWordPixelsFromCanvas(
            pageDiv,
            parseFloat(div.dataset.x) * scale,
            parseFloat(div.dataset.y) * scale,
            parseFloat(div.dataset.w) * scale,
            parseFloat(div.dataset.h) * scale,
            div
        );
    }
    
    const delBtn = div.querySelector('.word-delete-btn');
    if (delBtn) delBtn.style.display = 'none';

    // Restore card opacity if present
    const card = document.getElementById('card-' + div.id);
    if (card) {
        card.classList.remove('opacity-45', 'line-through');
    }

    saveState();
}

function restoreWordFromRedaction(div) {
    div.classList.remove('redact-target');
    div.style.backgroundColor = 'transparent';
    div.style.borderColor = 'transparent';
    div.style.borderStyle = 'dashed';
    div.style.backgroundImage = 'none';
    div.title = 'คลิกเพื่อแก้ไขคำนี้';
    
    const delBtn = div.querySelector('.word-delete-btn');
    if (delBtn) delBtn.style.display = 'block';

    // Strike out card if present
    const card = document.getElementById('card-' + div.id);
    if (card) {
        card.classList.add('opacity-45', 'line-through');
    }

    saveState();
}

document.getElementById('btn-smart-scan').addEventListener('click', async () => {
    const btn = document.getElementById('btn-smart-scan');
    const originalBtnHtml = btn.innerHTML;
    btn.innerText = 'กำลังสแกน...';
    btn.disabled = true;
    
    // Hide banner and stop pulsing
    const banner = document.getElementById('scan-prompt-banner');
    if (banner) banner.classList.add('hidden');
    btn.classList.remove('pulse-purple-btn');

    try {
        const formData = new FormData();
        const blob = new Blob([currentPdfBytes], { type: 'application/pdf' });
        formData.append('file', blob, 'document.pdf');

        const response = await fetch(API_BASE + '/detect-text/', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) throw new Error('Scan failed');
        
        const data = await response.json();
        
        // ลบกล่องม่วงเก่าออกก่อนเผื่อกดซ้ำ
        document.querySelectorAll('.word-overlay, .redact-target').forEach(el => el.remove());
        
        data.words.forEach(w => {
            const pageDiv = document.querySelector(`.page-container[data-page-index="${w.page}"]`);
            if (!pageDiv) return;
            const scale = parseFloat(pageDiv.dataset.scale || 1.5);
            
            const div = document.createElement('div');
            div.className = 'word-overlay cursor-pointer';
            div.style.left = `${w.x * scale}px`;
            div.style.top = `${w.y * scale}px`;
            div.style.width = `${w.w * scale}px`;
            div.style.height = `${w.h * scale}px`;
            div.title = "คลิกเพื่อแก้ไขคำนี้";
            div.id = 'word-' + Math.random().toString(36).substr(2, 9);
            
            // Store original coordinates
            div.dataset.x = w.x;
            div.dataset.y = w.y;
            div.dataset.w = w.w;
            div.dataset.h = w.h;
            div.dataset.page = w.page;
            
            // Tiny delete icon
            const delBtn = document.createElement('span');
            delBtn.className = 'word-delete-btn';
            delBtn.innerHTML = '×';
            delBtn.title = 'ลบคำนี้ทันที';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                redactWordDirectly(div);
            });
            div.appendChild(delBtn);
            
            div.addEventListener('click', (e) => {
                if (currentMode === 'redact-drag') {
                    if (div.classList.contains('redact-target')) {
                        restoreWordFromRedaction(div);
                    } else {
                        redactWordDirectly(div);
                    }
                    return;
                }

                div.classList.add('redact-target');
                div.style.backgroundColor = 'transparent';
                div.style.borderColor = 'transparent';
                div.style.borderStyle = 'none';
                div.style.backgroundImage = 'none';
                div.dataset.origX = w.x;
                div.dataset.origY = w.y;
                div.dataset.origW = w.w;
                div.dataset.origH = w.h;
                div.id = div.id || 'redact-' + Math.random().toString(36).substr(2, 9);
                
                // Smart Canvas Pixel Erase: Erases canvas letters using local sampled background color
                eraseWordPixelsFromCanvas(pageDiv, w.x * scale, w.y * scale, w.w * scale, w.h * scale);

                const txtDiv = createTextBox(pageDiv, w.x * scale, (w.y * scale) - 2, '', Math.max(12, w.h * scale * 0.8));
                txtDiv.dataset.sourceRedactId = div.id;

                // Immediately activate edit mode & focus cursor for instant typing over erased spot
                txtDiv.contentEditable = true;
                txtDiv.classList.remove('cursor-move');
                txtDiv.classList.add('cursor-text');
                setTimeout(() => {
                    txtDiv.focus();
                }, 30);
            });
            
            pageDiv.appendChild(div);
        });
        
    saveState();
    } catch (e) {
        alert("สแกนไม่สำเร็จ: " + e.message);
    } finally {
        btn.innerHTML = originalBtnHtml;
        btn.disabled = false;
    }
});

async function renderPDF(pdfBytes) {
    // ใช้ .slice(0) เพื่อก็อปปี้ข้อมูล ป้องกันไม่ให้ pdf.js ดึงข้อมูลไปจนไฟล์ต้นฉบับว่างเปล่า (0 bytes)
    // เพิ่ม CMap เพื่อให้รองรับภาษาไทย ป้องกันอักษรต่างด้าว
    const loadingTask = pdfjsLib.getDocument({ 
        data: pdfBytes.slice(0),
        cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/cmaps/',
        cMapPacked: true
    });
    pdfDocJs = await loadingTask.promise;
    
    for (let pageNum = 1; pageNum <= pdfDocJs.numPages; pageNum++) {
        const page = await pdfDocJs.getPage(pageNum);

        // ── คำนวณ scale ให้พอดีกับ canvas area ──────────────────────────────
        // raw page size at scale=1
        const rawViewport = page.getViewport({ scale: 1 });

        // หา available width ของ canvas area (หัก sidebar ซ้าย/ขวา + padding ซ้าย/ขวา)
        const leftSidebarW  = document.getElementById('left-sidebar')
            && !document.getElementById('left-sidebar').classList.contains('hidden') ? 340 : 0;
        const rightSidebarW = document.getElementById('redact-sidebar')
            && !document.getElementById('redact-sidebar').classList.contains('hidden') ? 340 : 0;

        const HORIZONTAL_PADDING = 80; // px — 40px each side canvas content padding
        const availableW = window.innerWidth - leftSidebarW - rightSidebarW - HORIZONTAL_PADDING;

        // คำนวณ scale ให้ page พอดีกับ available width (แนวตั้ง/แนวนอน)
        let scale = availableW / rawViewport.width;
        // ไม่ให้ขยายใหญ่เกิน 2× หรือเล็กกว่า 0.5×
        scale = Math.min(2.0, Math.max(0.5, scale));
        // ──────────────────────────────────────────────────────────────────────

        const viewport = page.getViewport({ scale });
        
        const pageDiv = document.createElement('div');
        pageDiv.className = 'page-container relative mx-auto mb-8 bg-white';
        pageDiv.style.width  = `${viewport.width}px`;
        pageDiv.style.height = `${viewport.height}px`;
        pageDiv.dataset.pageIndex = pageNum - 1;
        pageDiv.dataset.scale = scale;
        
        const canvas = document.createElement('canvas');
        canvas.width  = viewport.width;
        canvas.height = viewport.height;
        pageDiv.appendChild(canvas);
        
        // Drawing box for this page
        const dBox = document.createElement('div');
        dBox.className = 'drawing-box absolute border-2 border-dashed border-red-500 bg-red-500 bg-opacity-20 pointer-events-none hidden z-50';
        pageDiv.appendChild(dBox);
        
        pdfContainer.appendChild(pageDiv);
        
        const renderContext = { canvasContext: canvas.getContext('2d'), viewport };
        await page.render(renderContext).promise;
        
        const originalCanvas = document.createElement('canvas');
        originalCanvas.width = canvas.width;
        originalCanvas.height = canvas.height;
        originalCanvas.getContext('2d').drawImage(canvas, 0, 0);
        canvas.originalCanvas = originalCanvas;
        
        setupPageEvents(pageDiv, dBox);
        setupDrawingCanvas(pageDiv, viewport.width, viewport.height);
    }
}

function setupPageEvents(pageDiv, dBox) {
    const pageIndex = parseInt(pageDiv.dataset.pageIndex);
    
    pageDiv.addEventListener('mousedown', (e) => {
        if(e.target.classList.contains('text-overlay') || 
           e.target.classList.contains('whiteout-box') || 
           e.target.classList.contains('word-overlay') ||
           e.target.classList.contains('word-delete-btn')) {
            return;
        }
        selectElement(null);
        
        const rect = pageDiv.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        if (currentMode === 'eraser') {
            isBrushing = true;
            currentBrushStroke = [];
            const scale = parseFloat(pageDiv.dataset.scale || 1.5);
            // x, y are css pixels. We need canvas pixels!
            const canvas = pageDiv.querySelector('canvas');
            if (canvas) {
                const cx = (x / rect.width) * canvas.width;
                const cy = (y / rect.height) * canvas.height;
                const cr = (brushRadius / rect.width) * canvas.width;
                let colorObj = eraseBrushPixelsFromCanvas(pageDiv, cx, cy, cr) || {r:255, g:255, b:255};
                currentBrushStroke.push({x: x/scale, y: y/scale, r: brushRadius/scale, color: colorObj});
            }
        }
        else if(currentMode === 'whiteout' || currentMode === 'redact-drag') {

            isDrawing = true;
            startX = x;
            startY = y;
            activeDrawingBox = dBox;
            
            if (currentMode === 'redact-drag') {
                dBox.className = 'drawing-box absolute border-2 border-dashed border-red-500 bg-red-500 bg-opacity-10 pointer-events-none hidden z-50';
            } else {
                dBox.className = 'drawing-box absolute border-2 border-dashed border-blue-500 bg-blue-500 bg-opacity-20 pointer-events-none hidden z-50';
            }
            
            dBox.style.left = `${startX}px`;
            dBox.style.top = `${startY}px`;
            dBox.style.width = '0px';
            dBox.style.height = '0px';
            dBox.classList.remove('hidden');
        } else if (currentMode === 'text') {
            createTextBox(pageDiv, x, y, '');
        }
    });

    pageDiv.addEventListener('mousemove', (e) => {
        const rect = pageDiv.getBoundingClientRect();
        const currentX = e.clientX - rect.left;
        const currentY = e.clientY - rect.top;
        
        if (currentMode === 'eraser' && isBrushing) {
            const scale = parseFloat(pageDiv.dataset.scale || 1.5);
            const canvas = pageDiv.querySelector('canvas');
            if (canvas) {
                const cx = (currentX / rect.width) * canvas.width;
                const cy = (currentY / rect.height) * canvas.height;
                const cr = (brushRadius / rect.width) * canvas.width;
                let colorObj = eraseBrushPixelsFromCanvas(pageDiv, cx, cy, cr) || {r:255, g:255, b:255};
                currentBrushStroke.push({x: currentX/scale, y: currentY/scale, r: brushRadius/scale, color: colorObj});
            }
            return;
        }
        
        if(!isDrawing || (currentMode !== 'whiteout' && currentMode !== 'redact-drag') || activeDrawingBox !== dBox) return;
        
        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);
        
        dBox.style.left = `${Math.min(startX, currentX)}px`;
        dBox.style.top = `${Math.min(startY, currentY)}px`;
        dBox.style.width = `${width}px`;
        dBox.style.height = `${height}px`;
    });

    pageDiv.addEventListener('mouseup', (e) => {
        if (currentMode === 'eraser' && isBrushing) {
            isBrushing = false;
            if (currentBrushStroke.length > 0) {
                let pageErasers = allErasers.find(p => p.page === pageIndex);
                if (!pageErasers) {
                    pageErasers = { page: pageIndex, paths: [] };
                    allErasers.push(pageErasers);
                }
                pageErasers.paths.push([...currentBrushStroke]);
                currentBrushStroke = [];
                saveState();
            }
            return;
        }
        
        if(!isDrawing || (currentMode !== 'whiteout' && currentMode !== 'redact-drag') || activeDrawingBox !== dBox) return;
        isDrawing = false;
        dBox.classList.add('hidden');
        activeDrawingBox = null;
        
        const rect = pageDiv.getBoundingClientRect();
        const currentX = e.clientX - rect.left;
        const currentY = e.clientY - rect.top;
        
        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);
        
        if(width > 5 && height > 5) {
            const x0 = Math.min(startX, currentX);
            const y0 = Math.min(startY, currentY);
            
            if (currentMode === 'whiteout') {
                createWhiteoutBox(pageDiv, x0, y0, width, height);
            } else if (currentMode === 'redact-drag') {
                bulkRedactWordsInBox(pageDiv, x0, y0, x0 + width, y0 + height);
            }
        }
    });
    
    pageDiv.addEventListener('mouseleave', (e) => {
        if (currentMode === 'eraser' && isBrushing) {
            isBrushing = false;
            if (currentBrushStroke.length > 0) {
                let pageErasers = allErasers.find(p => p.page === pageIndex);
                if (!pageErasers) {
                    pageErasers = { page: pageIndex, paths: [] };
                    allErasers.push(pageErasers);
                }
                pageErasers.paths.push([...currentBrushStroke]);
                currentBrushStroke = [];
            }
        }
    });
}


function attachDeleteButton(div) {
    let existing = div.querySelector('.text-box-del-btn');
    if (existing) existing.remove();
    const delBtn = document.createElement('div');
    delBtn.className = 'word-delete-btn text-box-del-btn';
    delBtn.innerHTML = '&times;';
    delBtn.contentEditable = 'false';
    delBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); e.preventDefault();
        deleteSelectedBox(div);
    });
    div.appendChild(delBtn);
}

function createTextBox(pageDiv, x, y, initialText = '', initialFontSize = null) {
    const div = document.createElement('div');
    div.className = 'text-overlay cursor-text';
    div.innerText = initialText;
    div.style.left = `${x}px`;
    div.style.top = `${y}px`;
    div.style.fontFamily = `"${fontFamilySelect.value}"`;
    div.style.color = fontColorInput.value;
    div.style.lineHeight = '1.1';
    div.style.minWidth = '10px';
    div.style.minHeight = '1em';
    div.style.outline = 'none';
    
    const sizeToUse = initialFontSize ? initialFontSize : fontSizeInput.value;
    div.style.fontSize = `${sizeToUse}px`;
    div.style.backgroundColor = 'transparent';
    div.contentEditable = false;
    
    makeDraggable(div, pageDiv);
    attachDeleteButton(div);

    // Single click -> Select box (allows instant Backspace/Delete or Dragging)
    div.addEventListener('mousedown', (e) => {
        if (window.activeSelection === div && !div.isContentEditable) {
            // Second click on selected box -> Enter edit mode
            div.contentEditable = true;
            let dBtn = div.querySelector('.text-box-del-btn'); if(dBtn) dBtn.remove();
            div.classList.remove('cursor-move');
            div.classList.add('cursor-text');
            div.focus();
        } else {
            selectElement(div);
        }
    });

    // Double click -> Enter edit mode directly
    div.addEventListener('dblclick', (e) => {
        selectElement(div);
        div.contentEditable = true;
        div.classList.remove('cursor-move');
        div.classList.add('cursor-text');
        div.focus();
    });

    div.addEventListener('focus', () => {
        selectElement(div);
        if (initialText && div.innerText === initialText) {
            setTimeout(() => {
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(div);
                sel.removeAllRanges();
                sel.addRange(range);
            }, 10);
        }
    });

    // Keydown handling for Escape (exit edit) and Backspace (delete empty)
    div.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            div.contentEditable = false;
            div.blur();
        } else if (e.key === 'Backspace' || e.key === 'Delete') {
            setTimeout(() => {
                if (!div.innerText.trim() || div.innerText === '\n') {
                    deleteSelectedBox(div);
                }
            }, 10);
        }
    });

    div.addEventListener('blur', () => {
        div.contentEditable = false;
        div.classList.add('cursor-move');
        attachDeleteButton(div);
        div.classList.remove('cursor-text');
        if (!div.innerText.trim()) {
            deleteSelectedBox(div);
        } else {
            div.style.backgroundColor = 'transparent';
            div.style.backdropFilter = 'none';
            saveState();
        }
    });

    pageDiv.appendChild(div);
    selectElement(div);

    // If newly created empty box from text tool, enter edit mode immediately so user can type
    if (initialText === '') {
        div.contentEditable = true;
        div.classList.remove('cursor-move');
        div.classList.add('cursor-text');
        setTimeout(() => {
            div.focus();
        }, 20);
    }
    
    return div;
}

const btnBold = document.getElementById('btn-bold');
const btnItalic = document.getElementById('btn-italic');

fontFamilySelect.addEventListener('change', () => {
    if(window.activeTextBox) window.activeTextBox.style.fontFamily = `"${fontFamilySelect.value}"`;
});
fontSizeInput.addEventListener('input', () => {
    if(window.activeTextBox) window.activeTextBox.style.fontSize = `${fontSizeInput.value}px`;
});
fontColorInput.addEventListener('input', () => {
    if(window.activeTextBox) window.activeTextBox.style.color = fontColorInput.value;
});

btnBold.addEventListener('click', () => {
    if(window.activeTextBox) {
        const isBold = window.activeTextBox.style.fontWeight === 'bold';
        window.activeTextBox.style.fontWeight = isBold ? 'normal' : 'bold';
        btnBold.classList.toggle('bg-blue-100', !isBold);
        saveState();
    }
});

btnItalic.addEventListener('click', () => {
    if(window.activeTextBox) {
        const isItalic = window.activeTextBox.style.fontStyle === 'italic';
        window.activeTextBox.style.fontStyle = isItalic ? 'normal' : 'italic';
        btnItalic.classList.toggle('bg-blue-100', !isItalic);
        saveState();
    }
});

function updateToolbarUI(div) {
    fontFamilySelect.value = div.style.fontFamily.replace(/['"]/g, '');
    fontSizeInput.value = parseInt(div.style.fontSize);
    
    const isBold = div.style.fontWeight === 'bold';
    const isItalic = div.style.fontStyle === 'italic';
    const isUnderline = div.style.textDecoration === 'underline';
    
    btnBold.classList.toggle('bg-blue-100', isBold);
    btnItalic.classList.toggle('bg-blue-100', isItalic);
    btnUnderline.classList.toggle('bg-blue-100', isUnderline);
    
    alignBtns.forEach(btn => {
        const align = btn.id.replace('btn-align-', '');
        btn.classList.toggle('bg-blue-100', div.style.textAlign === align || (!div.style.textAlign && align === 'left'));
    });
}

function createWhiteoutBox(pageDiv, x, y, w, h) {
    const div = document.createElement('div');
    const colorInput = document.getElementById('whiteout-color');
    div.className = 'whiteout-box cursor-move';
    div.style.left = `${x}px`;
    div.style.top = `${y}px`;
    div.style.width = `${w}px`;
    div.style.height = `${h}px`;
    div.style.backgroundColor = colorInput.value;
    
    makeDraggable(div, pageDiv);
    attachDeleteButton(div);
    
    div.addEventListener('mousedown', (e) => {
        selectElement(div);
    });
    
    div.addEventListener('dblclick', () => { div.remove(); saveState(); });
    div.title = "ลากย้ายได้ / ดับเบิ้ลคลิก หรือ กด Backspace เพื่อลบกล่องนี้";
    
    pageDiv.appendChild(div);
}


function eraseBrushPixelsFromCanvas(pageDiv, x, y, r) {
    try {
        const canvas = pageDiv.querySelector('canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        
        const ix = Math.max(0, Math.floor(x - r - 1));
        const iy = Math.max(0, Math.floor(y - r - 1));
        const iw = Math.min(canvas.width - ix, Math.ceil(r * 2 + 2));
        const ih = Math.min(canvas.height - iy, Math.ceil(r * 2 + 2));
        
        if (iw <= 0 || ih <= 0) return;
        
        const sampleImg = ctx.getImageData(ix, iy, iw, ih).data;
        let lumList = [];
        for (let i = 0; i < sampleImg.length; i += 4) {
            lumList.push({
                r: sampleImg[i], g: sampleImg[i+1], b: sampleImg[i+2],
                lum: 0.299 * sampleImg[i] + 0.587 * sampleImg[i+1] + 0.114 * sampleImg[i+2]
            });
        }
        lumList.sort((a, b) => b.lum - a.lum);
        let topCount = Math.max(1, Math.floor(lumList.length * 0.2));
        let rSum = 0, gSum = 0, bSum = 0;
        for (let i = 0; i < topCount; i++) {
            rSum += lumList[i].r; gSum += lumList[i].g; bSum += lumList[i].b;
        }
        const bgR = rSum / topCount;
        const bgG = gSum / topCount;
        const bgB = bSum / topCount;
        const bgLum = lumList[0].lum;
        
        const imgData = ctx.getImageData(ix, iy, iw, ih);
        const data = imgData.data;
        
        for (let py = 0; py < ih; py++) {
            for (let px = 0; px < iw; px++) {
                const dx = (px + ix) - x;
                const dy = (py + iy) - y;
                if (dx*dx + dy*dy <= r*r) {
                    const i = (py * iw + px) * 4;
                    const lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
                    if (lum < bgLum - 20) {
                        data[i] = bgR; data[i+1] = bgG; data[i+2] = bgB;
                    }
                }
            }
        }
        ctx.putImageData(imgData, ix, iy);
    } catch(e) {}
}

function makeDraggable(element, container) {
    let dragging = false;
    let startPX, startPY, startLeft, startTop;
    let rafId = null;
    let pendingX, pendingY;

    element.addEventListener('pointerdown', onPointerDown);

    function onPointerDown(e) {
        if (element.classList.contains('text-overlay') && element.isContentEditable) return;
        if (e.button !== 0) return;

        selectElement(element);

        e.preventDefault();
        dragging = true;

        // Capture starting cursor position and element position (read once)
        startPX = e.clientX;
        startPY = e.clientY;
        startLeft = parseFloat(element.style.left) || 0;
        startTop  = parseFloat(element.style.top)  || 0;

        // Promote to GPU layer for zero-jank movement
        element.style.willChange = 'left, top';
        element.setPointerCapture(e.pointerId);

        document.addEventListener('pointermove', onPointerMove, { passive: false });
        document.addEventListener('pointerup',   onPointerUp);
    }

    function onPointerMove(e) {
        if (!dragging) return;
        e.preventDefault();

        // Calculate new position relative to starting point
        pendingX = startLeft + (e.clientX - startPX);
        pendingY = startTop  + (e.clientY - startPY);

        // Batch the DOM write to the next animation frame — stays perfectly in sync with display refresh
        if (!rafId) {
            rafId = requestAnimationFrame(applyPosition);
        }
    }

    function applyPosition() {
        rafId = null;
        element.style.left = pendingX + 'px';
        element.style.top  = pendingY + 'px';
    }

    function onPointerUp() {
        if (!dragging) return;
        dragging = false;

        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
            element.style.left = pendingX + 'px';
            element.style.top  = pendingY + 'px';
        }

        element.style.willChange = '';
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup',   onPointerUp);
        saveState();
    }
}

// 4. บันทึกและส่งข้อมูลไปยัง FastAPI Backend
downloadBtn.addEventListener('click', async () => {
    downloadBtn.innerText = 'กำลังส่งไปประมวลผล...';
    downloadBtn.disabled = true;
    pdfContainer.classList.add('exporting'); 

    try {
        const usedFonts = new Set();
        const texts = [];
        const whiteouts = [];
        const redacts = [];
        
        document.querySelectorAll('.page-container').forEach(pageDiv => {
            const pageIndex = parseInt(pageDiv.dataset.pageIndex);
            const scale = parseFloat(pageDiv.dataset.scale);
            
            pageDiv.querySelectorAll('.text-overlay').forEach(div => {
                const text = div.innerText;
                if(!text) return;

                const cssLeft = parseFloat(div.style.left);
                const cssTop = parseFloat(div.style.top);
                const fFamily = div.style.fontFamily.replace(/['"]/g, '');
                usedFonts.add(fFamily);

                texts.push({
                    page: pageIndex,
                    text: text,
                    x: cssLeft / scale,
                    y: cssTop / scale,
                    width: parseFloat(div.style.width) / scale || 200,
                    height: parseFloat(div.style.height) / scale || 50,
                    font: fFamily,
                    size: parseFloat(div.style.fontSize) / scale,
                    color: div.style.color || 'rgb(0, 0, 0)',
                    bold: div.style.fontWeight === 'bold',
                    italic: div.style.fontStyle === 'italic',
                    align: div.style.textAlign || 'left',
                    underline: div.style.textDecoration === 'underline',
                    bg_color: 'transparent' // บังคับไม่ให้ส่งสีพื้นหลังไปตอนสร้าง PDF
                });
            });

            pageDiv.querySelectorAll('.whiteout-box').forEach(div => {
                whiteouts.push({
                    page: pageIndex,
                    x: parseFloat(div.style.left) / scale,
                    y: parseFloat(div.style.top) / scale,
                    width: parseFloat(div.style.width) / scale,
                    height: parseFloat(div.style.height) / scale,
                    color: div.style.backgroundColor || 'rgb(255, 255, 255)'
                });
            });

            const drawCanvas = pageDiv.querySelector('.drawing-layer-canvas');
            if (drawCanvas) {
                const ctx = drawCanvas.getContext('2d');
                const pData = ctx.getImageData(0, 0, drawCanvas.width, drawCanvas.height).data;
                let hasDrawings = false;
                for (let i = 3; i < pData.length; i += 4) {
                    if (pData[i] > 0) { hasDrawings = true; break; }
                }
                if (hasDrawings) {
                    whiteouts.push({
                        page: pageIndex,
                        x: 0,
                        y: 0,
                        width: drawCanvas.width / scale,
                        height: drawCanvas.height / scale,
                        image_data: drawCanvas.toDataURL('image/png')
                    });
                }
            }

            pageDiv.querySelectorAll('.redact-target').forEach(div => {
                const rx = parseFloat(div.dataset.origX || div.dataset.x || (parseFloat(div.style.left) / scale));
                const ry = parseFloat(div.dataset.origY || div.dataset.y || (parseFloat(div.style.top) / scale));
                const rw = parseFloat(div.dataset.origW || div.dataset.w || (parseFloat(div.style.width) / scale));
                const rh = parseFloat(div.dataset.origH || div.dataset.h || (parseFloat(div.style.height) / scale));
                
                if (!isNaN(rx) && !isNaN(ry) && !isNaN(rw) && !isNaN(rh) && rw > 0 && rh > 0) {
                    redacts.push({
                        page: pageIndex,
                        x: rx,
                        y: ry,
                        width: rw,
                        height: rh,
                        fill: null  // Transparent character removal without painting any background box
                    });
                }
            });
        });

        const payloadData = JSON.stringify({ texts, whiteouts, redacts, erasers: allErasers });
        const formData = new FormData();
        const blob = new Blob([currentPdfBytes], { type: 'application/pdf' });
        formData.append('file', blob, 'document.pdf');
        formData.append('data', payloadData);

        for (const fontName of usedFonts) {
            let fileName = fontName;
            if (!fileName.endsWith('.ttf') && !fileName.endsWith('.otf')) {
                fileName = `${fontName}.ttf`;
            }
            // If the font is Prompt, fetch from Google Fonts CDN. Otherwise, fetch from local thai14font folder.
            let fontUrl = fontName === 'Prompt' || fontName === 'Prompt.ttf' 
                ? 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/prompt/Prompt-Regular.ttf' 
                : `./thai14font/${fileName}`;
            
            try {
                const res = await fetch(fontUrl);
                if(res.ok) {
                    const fontBlob = await res.blob();
                    formData.append('fonts', fontBlob, fontName);
                }
            } catch(e) {
                console.warn("Could not fetch font:", fontName);
            }
        }

        const response = await fetch(API_BASE + '/edit-pdf/', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
        }

        const resultBlob = await response.blob();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(resultBlob);
        link.download = 'edited_document.pdf';
        link.click();
        
    } catch (error) {
        console.error('Error saving PDF:', error);
        alert('เกิดข้อผิดพลาดในการส่งข้อมูลไปที่ Server: ' + error.message);
    } finally {
        pdfContainer.classList.remove('exporting');
        downloadBtn.innerText = 'บันทึก PDF';
        downloadBtn.disabled = false;
    }
});

// Size Controls
document.getElementById('btn-size-up').addEventListener('click', () => {
    fontSizeInput.value = parseInt(fontSizeInput.value) + 1;
    fontSizeInput.dispatchEvent(new Event('input'));
    saveState();
});
document.getElementById('btn-size-down').addEventListener('click', () => {
    fontSizeInput.value = Math.max(8, parseInt(fontSizeInput.value) - 1);
    fontSizeInput.dispatchEvent(new Event('input'));
    saveState();
});

btnUnderline.addEventListener('click', () => {
    if(window.activeTextBox) {
        const isUnderline = window.activeTextBox.style.textDecoration === 'underline';
        window.activeTextBox.style.textDecoration = isUnderline ? 'none' : 'underline';
        btnUnderline.classList.toggle('bg-blue-100', !isUnderline);
        saveState();
    }
});

alignBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        if(window.activeTextBox) {
            const align = btn.id.replace('btn-align-', '');
            window.activeTextBox.style.textAlign = align;
            alignBtns.forEach(b => b.classList.remove('bg-blue-100'));
            btn.classList.add('bg-blue-100');
            saveState();
        }
    });
});

highlightColorInput.addEventListener('input', () => {
    document.getElementById('highlight-indicator').style.backgroundColor = highlightColorInput.value;
    if(window.activeTextBox) {
        window.activeTextBox.style.backgroundColor = highlightColorInput.value;
        saveState();
    }
});

// Color Indicator Update
fontColorInput.addEventListener('input', () => {
    document.getElementById('color-indicator').style.backgroundColor = fontColorInput.value;
});

// Delete Button Logic
const btnDelete = document.getElementById('btn-delete');
btnDelete.addEventListener('click', () => {
    deleteSelectedBox(window.activeSelection || window.activeTextBox);
});

// ==========================================
// PDF TOOLS SUITE: MODAL, TABS, ORGANIZER, CONVERTERS, SETTINGS
// ==========================================

const toolsModal = document.getElementById('tools-modal');
const toolsModalContent = document.getElementById('tools-modal-content');
const btnOpenTools = document.getElementById('btn-open-tools');
const btnCloseTools = document.getElementById('btn-close-tools');

// Open Modal
btnOpenTools.addEventListener('click', () => {
    toolsModal.classList.remove('hidden');
    setTimeout(() => {
        toolsModalContent.classList.remove('scale-95', 'opacity-0');
        toolsModalContent.classList.add('scale-100', 'opacity-100');
    }, 10);
    loadOrganizerThumbnails();
});

// Close Modal
function closeToolsModal() {
    toolsModalContent.classList.remove('scale-100', 'opacity-100');
    toolsModalContent.classList.add('scale-95', 'opacity-0');
    setTimeout(() => {
        toolsModal.classList.add('hidden');
    }, 300);
}
btnCloseTools.addEventListener('click', closeToolsModal);
toolsModal.addEventListener('click', (e) => {
    if (e.target === toolsModal) closeToolsModal();
});

// Tab Switching — scoped to #tools-modal only to avoid colliding with left-sidebar
const toolsModalEl = document.getElementById('tools-modal');
toolsModalEl.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        toolsModalEl.querySelectorAll('.tab-btn').forEach(b => {
            b.classList.remove('active', 'text-blue-600', 'bg-blue-50', 'border', 'border-blue-100', 'text-indigo-600', 'bg-indigo-50', 'border-indigo-100');
            b.classList.add('text-slate-600', 'hover:bg-slate-100');
        });
        btn.classList.remove('text-slate-600', 'hover:bg-slate-100');
        btn.classList.add('active', 'text-indigo-600', 'bg-indigo-50', 'border', 'border-indigo-100');

        toolsModalEl.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
        document.getElementById(btn.dataset.tab).classList.remove('hidden');
    });
});

// Render Organizer Thumbnails (Drag-and-Drop)
async function loadOrganizerThumbnails() {
    const grid = document.getElementById('organizer-grid');
    grid.innerHTML = '<p class="col-span-full text-center text-xs text-gray-400 py-8">กำลังโหลดหน้ากระดาษ...</p>';
    
    if (!currentPdfBytes) return;
    
    try {
        // เพิ่ม CMap ให้รองรับภาษาไทยในหน้าพรีวิวจัดระเบียบ
        const loadingTask = pdfjsLib.getDocument({ 
            data: currentPdfBytes.slice(0),
            cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/cmaps/',
            cMapPacked: true
        });
        const pdf = await loadingTask.promise;
        grid.innerHTML = '';
        
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 0.3 }); // Small thumbnail
            
            const card = document.createElement('div');
            card.className = 'bg-white border border-gray-200 rounded-lg p-2 flex flex-col items-center relative shadow-sm hover:shadow-md transition-shadow group';
            card.draggable = true;
            card.dataset.pageIndex = i - 1; // 0-based index
            
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            canvas.className = 'border border-gray-100 rounded pointer-events-none mb-2';
            card.appendChild(canvas);
            
            const renderContext = { canvasContext: canvas.getContext('2d'), viewport: viewport };
            await page.render(renderContext).promise;
        
        const originalCanvas = document.createElement('canvas');
        originalCanvas.width = canvas.width;
        originalCanvas.height = canvas.height;
        originalCanvas.getContext('2d').drawImage(canvas, 0, 0);
        canvas.originalCanvas = originalCanvas;
            
            const numLabel = document.createElement('span');
            numLabel.className = 'text-xs font-bold text-gray-500';
            numLabel.innerText = `หน้า ${i}`;
            card.appendChild(numLabel);
            
            // Delete Page Button
            const delBtn = document.createElement('button');
            delBtn.className = 'absolute top-1 right-1 bg-red-500 hover:bg-red-600 text-white p-1 rounded-full shadow opacity-0 group-hover:opacity-100 transition-opacity';
            delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
            delBtn.title = 'ลบหน้านี้';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                card.remove();
                renameThumbnails();
            });
            card.appendChild(delBtn);
            
            // Drag Events
            card.addEventListener('dragstart', handleDragStart);
            card.addEventListener('dragover', handleDragOver);
            card.addEventListener('drop', handleDrop);
            card.addEventListener('dragend', handleDragEnd);
            
            grid.appendChild(card);
        }
    } catch (e) {
        console.error(e);
        grid.innerHTML = '<p class="col-span-full text-center text-xs text-red-500 py-8">โหลดหน้าพรีวิวผิดพลาด</p>';
    }
}

// Rename page labels in thumbnail view dynamically
function renameThumbnails() {
    const grid = document.getElementById('organizer-grid');
    const cards = grid.querySelectorAll('[data-page-index]');
    cards.forEach((card, idx) => {
        const span = card.querySelector('span');
        if (span) span.innerText = `หน้า ${idx + 1}`;
    });
}

// Drag & Drop Handlers
let dragSrcEl = null;
function handleDragStart(e) {
    this.style.opacity = '0.4';
    dragSrcEl = this;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', this.innerHTML);
}
function handleDragOver(e) {
    if (e.preventDefault) e.preventDefault();
    return false;
}
function handleDrop(e) {
    e.stopPropagation();
    if (dragSrcEl !== this) {
        // Swap DOM positions
        const grid = document.getElementById('organizer-grid');
        const children = Array.from(grid.children);
        const fromIdx = children.indexOf(dragSrcEl);
        const toIdx = children.indexOf(this);
        
        if (fromIdx < toIdx) {
            grid.insertBefore(dragSrcEl, this.nextSibling);
        } else {
            grid.insertBefore(dragSrcEl, this);
        }
        renameThumbnails();
    }
    return false;
}
function handleDragEnd(e) {
    this.style.opacity = '1';
}

// Save Organization (Reorder & Delete Pages)
document.getElementById('btn-save-organization').addEventListener('click', async () => {
    const grid = document.getElementById('organizer-grid');
    const cards = Array.from(grid.querySelectorAll('[data-page-index]'));
    if (cards.length === 0) {
        alert('กรุณาเหลือหน้าไว้จัดระเบียบอย่างน้อย 1 หน้า');
        return;
    }
    
    const pageIndexes = cards.map(c => parseInt(c.dataset.pageIndex));
    
    const btn = document.getElementById('btn-save-organization');
    btn.innerText = 'กำลังบันทึก...';
    btn.disabled = true;
    
    try {
        const formData = new FormData();
        const blob = new Blob([currentPdfBytes], { type: 'application/pdf' });
        formData.append('file', blob, 'document.pdf');
        formData.append('pages', JSON.stringify(pageIndexes));
        
        const response = await fetch(API_BASE + '/reorder-pages/', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) throw new Error('Reorder failed');
        
        const newPdfBlob = await response.blob();
        currentPdfBytes = new Uint8Array(await newPdfBlob.arrayBuffer());
        
        pdfContainer.innerHTML = '';
        await renderPDF(currentPdfBytes);
        
        alert('จัดระเบียบหน้าเรียบร้อยแล้ว!');
        closeToolsModal();
    } catch(e) {
        alert('เกิดข้อผิดพลาดในการบันทึก: ' + e.message);
    } finally {
        btn.innerText = 'บันทึกผลการสลับหน้า';
        btn.disabled = false;
    }
});

// Append PDF File to current PDF
document.getElementById('append-pdf-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const label = document.querySelector('label[for="append-pdf-input"]');
    const originalText = label.innerHTML;
    label.innerText = 'กำลังรวมไฟล์...';
    
    try {
        const formData = new FormData();
        const blobA = new Blob([currentPdfBytes], { type: 'application/pdf' });
        formData.append('file_a', blobA, 'original.pdf');
        formData.append('file_b', file, file.name);
        
        const response = await fetch(API_BASE + '/merge-pdfs/', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) throw new Error('Merge failed');
        
        const newPdfBlob = await response.blob();
        currentPdfBytes = new Uint8Array(await newPdfBlob.arrayBuffer());
        
        pdfContainer.innerHTML = '';
        await renderPDF(currentPdfBytes);
        
        // Refresh Thumbnails
        await loadOrganizerThumbnails();
        alert('รวมไฟล์ต่อท้ายสำเร็จ!');
    } catch(e) {
        alert('เกิดข้อผิดพลาดในการรวมไฟล์: ' + e.message);
    } finally {
        label.innerHTML = originalText;
        e.target.value = '';
    }
});

// Convert PDF to JPEGs (ZIP)
document.getElementById('btn-convert-pdf-to-jpg').addEventListener('click', async () => {
    const btn = document.getElementById('btn-convert-pdf-to-jpg');
    const originalText = btn.innerHTML;
    btn.innerText = 'กำลังแปลงไฟล์...';
    btn.disabled = true;
    
    try {
        const formData = new FormData();
        const blob = new Blob([currentPdfBytes], { type: 'application/pdf' });
        formData.append('file', blob, 'document.pdf');
        
        const response = await fetch(API_BASE + '/convert-to-images/', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) throw new Error('Conversion failed');
        
        const zipBlob = await response.blob();
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'pdf_images.zip';
        a.click();
        URL.revokeObjectURL(url);
    } catch(e) {
        alert('แปลงไฟล์ล้มเหลว: ' + e.message);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
});

// Select Images for conversion
let selectedImages = [];
document.getElementById('convert-images-input').addEventListener('change', (e) => {
    selectedImages = Array.from(e.target.files);
    const text = document.getElementById('image-count-txt');
    const convertBtn = document.getElementById('btn-convert-images-to-pdf');
    
    if (selectedImages.length > 0) {
        text.innerText = `เลือกแล้ว ${selectedImages.length} รูปภาพ`;
        convertBtn.disabled = false;
    } else {
        text.innerText = 'ยังไม่มีภาพที่เลือก';
        convertBtn.disabled = true;
    }
});

// Convert Images to PDF
document.getElementById('btn-convert-images-to-pdf').addEventListener('click', async () => {
    if (selectedImages.length === 0) return;
    
    const btn = document.getElementById('btn-convert-images-to-pdf');
    btn.innerText = 'กำลังสร้าง PDF...';
    btn.disabled = true;
    
    try {
        const formData = new FormData();
        selectedImages.forEach((img, idx) => {
            formData.append('images', img, img.name);
        });
        
        const response = await fetch(API_BASE + '/images-to-pdf/', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) throw new Error('Images to PDF failed');
        
        const pdfBlob = await response.blob();
        currentPdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());
        
        placeholder.classList.add('hidden');
        pdfContainer.classList.remove('hidden');
        toolbar.classList.remove('hidden');
        if (leftSidebar) {
            leftSidebar.classList.remove('hidden');
            document.body.classList.add('left-sidebar-open');
        }
        downloadBtn.classList.remove('hidden');
        document.getElementById('btn-smart-scan').classList.remove('hidden');
        document.getElementById('btn-open-tools').classList.remove('hidden');

        pdfContainer.innerHTML = '';
        await renderPDF(currentPdfBytes);
        
        alert('สร้างไฟล์ PDF จากรูปภาพสำเร็จ!');
        closeToolsModal();
    } catch(e) {
        alert('การแปลงรูปเป็น PDF ผิดพลาด: ' + e.message);
    } finally {
        btn.innerText = 'สร้างไฟล์ PDF จากรูปภาพ';
        btn.disabled = false;
        selectedImages = [];
        document.getElementById('image-count-txt').innerText = 'ยังไม่มีภาพที่เลือก';
        document.getElementById('convert-images-input').value = '';
    }
});

// Update opacity text label dynamically
document.getElementById('pdf-watermark-opacity').addEventListener('input', (e) => {
    document.getElementById('watermark-opacity-txt').innerText = `${e.target.value}%`;
});

// Apply Settings (Watermark, Password, Crop, Page Numbers)
document.getElementById('btn-apply-settings').addEventListener('click', async () => {
    const btn = document.getElementById('btn-apply-settings');
    btn.innerText = 'กำลังประมวลผล...';
    btn.disabled = true;
    
    try {
        const config = {
            password: document.getElementById('pdf-password-protect').value,
            crop_top: parseFloat(document.getElementById('pdf-crop-top').value) || 0,
            crop_bottom: parseFloat(document.getElementById('pdf-crop-bottom').value) || 0,
            crop_left: parseFloat(document.getElementById('pdf-crop-left').value) || 0,
            crop_right: parseFloat(document.getElementById('pdf-crop-right').value) || 0,
            watermark: document.getElementById('pdf-watermark-text').value,
watermark_opacity: parseFloat(document.getElementById('pdf-watermark-opacity').value) / 100,
            watermark_rotation: parseInt(document.getElementById('pdf-watermark-rotation').value) || 0,
            page_numbers: document.getElementById('pdf-toggle-pagenum').checked,
            pagenum_pos: document.getElementById('pdf-pagenum-pos').value,
            pagenum_format: document.getElementById('pdf-pagenum-format').value,
            pagenum_start_page: parseInt(document.getElementById('pdf-pagenum-start-page').value) || 1,
            pagenum_start_val: parseInt(document.getElementById('pdf-pagenum-start-val').value) || 1
        };
        
        const formData = new FormData();
        const blob = new Blob([currentPdfBytes], { type: 'application/pdf' });
        formData.append('file', blob, 'document.pdf');
        formData.append('config', JSON.stringify(config));
        
        const response = await fetch(API_BASE + '/apply-page-styling/', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) throw new Error('Style application failed');
        
        const newPdfBlob = await response.blob();
        currentPdfBytes = new Uint8Array(await newPdfBlob.arrayBuffer());
        
        pdfContainer.innerHTML = '';
        await renderPDF(currentPdfBytes);
        
        alert('บันทึกการตั้งค่าหน้ากระดาษเรียบร้อย!');
        closeToolsModal();
    } catch(e) {
        alert('เกิดข้อผิดพลาดในการประมวลผล: ' + e.message);
    } finally {
        btn.innerText = 'ยอมรับและเขียนสไตล์ลงไฟล์ PDF';
        btn.disabled = false;
    }
});

// Toggle Page Numbers Settings Panel
document.getElementById('pdf-toggle-pagenum').addEventListener('change', (e) => {
    const panel = document.getElementById('pagenum-settings-panel');
    if (panel) {
        if (e.target.checked) {
            panel.classList.remove('hidden');
        } else {
            panel.classList.add('hidden');
        }
    }
});

// AI Auto Redact (Privacy Control) — detect only, user applies each mark
const autoRedactTriggerBtn = document.getElementById('btn-auto-redact');
if (autoRedactTriggerBtn) {
    autoRedactTriggerBtn.addEventListener('click', async () => {
        const btn = autoRedactTriggerBtn;
        const originalText = btn.innerHTML;
        btn.innerText = 'กำลังตรวจหาข้อมูลอ่อนไหว...';
        btn.disabled = true;

    try {
        const formData = new FormData();
        const blob = new Blob([currentPdfBytes], { type: 'application/pdf' });
        formData.append('file', blob, 'document.pdf');

        const response = await fetch(API_BASE + '/auto-redact/', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) throw new Error('Auto-redact failed');
        
        const data = await response.json();
        
        const redactList = document.getElementById('redact-list');
        redactList.innerHTML = '';
        
        let count = 0;
        data.redacts.forEach(r => {
            const pageDiv = document.querySelector(`.page-container[data-page-index="${r.page}"]`);
            if (!pageDiv) return;
            const scale = parseFloat(pageDiv.dataset.scale || 1.5);
            
            // Skip duplicates
            let isDuplicate = false;
            pageDiv.querySelectorAll('.ai-pending-overlay, .redact-target').forEach(existing => {
                const exX = parseFloat(existing.dataset.x);
                const exY = parseFloat(existing.dataset.y);
                if (Math.abs(exX - r.x) < 5 && Math.abs(exY - r.y) < 5) isDuplicate = true;
            });
            if (isDuplicate) return;
            
            const overlayId = 'ai-pending-' + Math.random().toString(36).substr(2, 9);
            
            // ── Pending overlay: soft amber highlight, NOT red X ─────────────
            const div = document.createElement('div');
            div.className = 'ai-pending-overlay';
            div.id = overlayId;
            div.style.cssText = `
                position:absolute;
                left:${r.x * scale}px; top:${r.y * scale}px;
                width:${r.w * scale}px; height:${r.h * scale}px;
                background:rgba(251,191,36,0.18);
                border:1.5px dashed rgba(251,146,60,0.7);
                border-radius:4px;
                z-index:8;
                cursor:default;
                transition:all 0.2s;
                box-shadow:0 0 0 0 rgba(251,146,60,0);
                animation: ai-pending-pulse 2.5s ease-in-out infinite;
            `;
            div.dataset.x = r.x;
            div.dataset.y = r.y;
            div.dataset.w = r.w;
            div.dataset.h = r.h;
            div.dataset.page = r.page;
            div.title = `ตรวจพบ: "${r.text}" — รอการยืนยัน`;
            
            pageDiv.appendChild(div);
            count++;
            
            // ── Sidebar card ────────────────────────────────────────────────
            const typeLabel = r.type || 'ข้อมูลอ่อนไหว';
            const textLabel = r.text || 'เซนเซอร์ข้อความ';
            
            const card = document.createElement('div');
            card.id = 'card-' + overlayId;
            card.className = 'ai-detect-card rounded-xl border border-amber-200/80 bg-amber-50/70 transition-all duration-200 overflow-hidden';
            card.dataset.overlayId = overlayId;

            // Card body — click to jump & highlight
            const cardBody = document.createElement('div');
            cardBody.className = 'flex items-start gap-2.5 p-2.5 cursor-pointer hover:bg-amber-100/60 transition-colors';
            cardBody.innerHTML = `
                <div class="mt-0.5 flex-none w-5 h-5 rounded-md bg-amber-100 flex items-center justify-center">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-1.5 mb-0.5">
                        <span class="px-1.5 py-0.5 rounded-md bg-amber-200 text-amber-900 font-black text-[9px] tracking-wide uppercase">${typeLabel}</span>
                        <span class="text-[9px] text-slate-400 font-medium">หน้า ${r.page + 1}</span>
                    </div>
                    <span class="block font-semibold text-slate-700 text-xs truncate">"${textLabel}"</span>
                    <span class="text-[9px] text-amber-600 font-medium mt-0.5 block">⏳ รอการยืนยันจากคุณ</span>
                </div>
            `;
            cardBody.addEventListener('click', () => {
                pageDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
                div.style.boxShadow = '0 0 0 3px rgba(251,146,60,0.5)';
                setTimeout(() => { div.style.boxShadow = '0 0 0 0 rgba(251,146,60,0)'; }, 1800);
            });

            // Action bar — two buttons: Apply mark / Dismiss
            const actionBar = document.createElement('div');
            actionBar.className = 'flex items-center gap-1.5 justify-end border-t border-amber-100 px-2.5 py-1.5 bg-white/50';
            actionBar.innerHTML = `
                <button class="btn-dismiss-detect flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-600 font-bold hover:bg-slate-100 px-2 py-0.5 rounded-md transition-all">
                    ไม่ใช่
                </button>
                <button class="btn-apply-redact flex items-center gap-1 text-[10px] text-red-600 hover:text-red-800 font-bold bg-red-50 hover:bg-red-100 border border-red-200 px-2.5 py-1 rounded-md transition-all">
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    ใส่กากบาท ✕
                </button>
            `;

            // "Apply" — convert pending overlay to full red redact
            actionBar.querySelector('.btn-apply-redact').addEventListener('click', (e) => {
                e.stopPropagation();
                applyRedactOverlay(div, card, r, scale);
            });

            // "Dismiss" — remove overlay and card entirely
            actionBar.querySelector('.btn-dismiss-detect').addEventListener('click', (e) => {
                e.stopPropagation();
                div.remove();
                card.remove();
                updateRedactCount();
            });

            card.appendChild(cardBody);
            card.appendChild(actionBar);
            redactList.appendChild(card);
        });
        
        document.getElementById('redact-count').innerText = count;
        if (count > 0) {
            document.getElementById('redact-sidebar').classList.remove('hidden');
            document.body.classList.add('right-sidebar-open');
        } else {
            alert('ไม่พบข้อมูลส่วนบุคคลอ่อนไหวบนเอกสารนี้ครับ');
        }
        
        saveState();
    } catch (e) {
        alert('เกิดข้อผิดพลาดในการเซนเซอร์อัตโนมัติ: ' + e.message);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
    });
}

// ── Helper: apply redact mark on a single pending overlay ─────────────────────
function applyRedactOverlay(div, card, r, scale) {
    // Convert pending overlay → red X crossout
    div.className = 'word-overlay cursor-pointer redact-target';
    div.style.cssText = `
        position:absolute;
        left:${div.style.left}; top:${div.style.top};
        width:${div.style.width}; height:${div.style.height};
        background-color:rgba(239,68,68,0.3);
        border:1.5px solid red;
        background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100%25' height='100%25'%3E%3Cline x1='0' y1='0' x2='100%25' y2='100%25' stroke='red' stroke-width='2'/%3E%3Cline x1='100%25' y1='0' x2='0' y2='100%25' stroke='red' stroke-width='2'/%3E%3C/svg%3E");
        border-radius:4px;
        z-index:8;
        cursor:pointer;
        animation:none;
    `;
    div.title = 'คลิกเพื่อยกเลิกกากบาทแดงนี้';
    div.addEventListener('click', () => restoreWordFromRedaction(div));

    // Update card UI → confirmed state
    card.className = 'rounded-xl border border-red-100 bg-red-50/60 transition-all duration-200 overflow-hidden ai-confirmed-card';
    card.innerHTML = `
        <div class="flex items-start gap-2.5 p-2.5">
            <div class="mt-0.5 flex-none w-5 h-5 rounded-md bg-red-100 flex items-center justify-center">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5 mb-0.5">
                    <span class="px-1.5 py-0.5 rounded-md bg-red-200 text-red-800 font-black text-[9px] tracking-wide uppercase">${r.type || 'ข้อมูลอ่อนไหว'}</span>
                    <span class="text-[9px] text-slate-400 font-medium">หน้า ${r.page + 1}</span>
                </div>
                <span class="block font-semibold text-slate-700 text-xs truncate">"${r.text || ''}"</span>
                <span class="text-[9px] text-red-500 font-bold mt-0.5 block">✕ ใส่กากบาทแล้ว</span>
            </div>
            <button class="btn-undo-redact text-[9px] text-slate-400 hover:text-slate-700 font-bold hover:bg-slate-100 px-1.5 py-0.5 rounded-md transition-all flex-none">ยกเลิก</button>
        </div>
    `;
    card.querySelector('.btn-undo-redact').addEventListener('click', (e) => {
        e.stopPropagation();
        // Restore back to pending state by removing both and re-adding
        div.remove();
        card.remove();
        updateRedactCount();
    });

    updateRedactCount();
    saveState();
}

// ── Helper: update redact-count badge ─────────────────────────────────────────
function updateRedactCount() {
    const list = document.getElementById('redact-list');
    if (!list) return;
    const total = list.querySelectorAll('.ai-detect-card, .ai-confirmed-card, .rounded-xl').length;
    const countEl = document.getElementById('redact-count');
    if (countEl) countEl.innerText = total;
    if (total === 0) {
        const sidebar = document.getElementById('redact-sidebar');
        if (sidebar) sidebar.classList.add('hidden');
        document.body.classList.remove('right-sidebar-open');
    }
}

// Close Redact Sidebar Listener
const btnCloseRedact = document.getElementById('btn-close-redact-sidebar');
if (btnCloseRedact) {
    btnCloseRedact.addEventListener('click', () => {
        const sidebar = document.getElementById('redact-sidebar');
        if (sidebar) sidebar.classList.add('hidden');
        document.body.classList.remove('right-sidebar-open');
    });
}

// ── WOW Interactive 3D Parallax Tilt on Hero Card ──────────────────────────────
document.addEventListener('mousemove', (e) => {
    const placeholder = document.getElementById('placeholder');
    if (placeholder && !placeholder.classList.contains('hidden')) {
        const card = placeholder.querySelector('.hero-glow-card');
        if (card) {
            const cx = window.innerWidth / 2;
            const cy = window.innerHeight / 2;
            const dx = (e.clientX - cx) / cx;
            const dy = (e.clientY - cy) / cy;
            const tiltX = (dy * -7).toFixed(2);
            const tiltY = (dx * 7).toFixed(2);
            card.style.transform = `perspective(1000px) rotateX(${tiltX}deg) rotateY(${tiltY}deg)`;
        }
    }
});

document.addEventListener('mouseleave', () => {
    const card = document.querySelector('#placeholder .hero-glow-card');
    if (card) {
        card.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg)';
    }
});

if(document.getElementById('btn-banner-scan')) {
    document.getElementById('btn-banner-scan').addEventListener('click', () => {
        const scanBtn = document.getElementById('btn-smart-scan');
        if(scanBtn) scanBtn.click();
    });
}


function updateEraserCursor() {
    if (currentMode !== 'eraser') return;
    const r = brushRadius;
    const size = r * 2;
    const center = r;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${center}" cy="${center}" r="${r-1}" fill="none" stroke="red" stroke-width="1.5"/></svg>`;
    const url = `url('data:image/svg+xml;utf8,${encodeURIComponent(svg)}') ${center} ${center}, crosshair`;
    document.getElementById('pdf-container').style.cursor = url;
}

const eraserSizeInput = document.getElementById('eraser-size');
if (eraserSizeInput) {
    eraserSizeInput.addEventListener('input', (e) => {
        brushRadius = parseInt(e.target.value);
        document.getElementById('eraser-size-val').innerText = `${brushRadius} px`;
        updateEraserCursor();
    });
}
