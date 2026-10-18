document.addEventListener('DOMContentLoaded', () => {
    const bgInput = document.getElementById('bgInput');
    const saveBtn = document.getElementById('saveBtn');
    const clearBtn = document.getElementById('clearBtn');
    const maskToggle = document.getElementById('maskToggle');
    const cursorSelect = document.getElementById('cursorSelect');
    
    const customCursorArea = document.getElementById('customCursorArea');
    const customCursorFile = document.getElementById('customCursorFile');
    const uploadCursorBtn = document.getElementById('uploadCursorBtn');
    const cursorPreview = document.getElementById('cursorPreview');
    const msg = document.getElementById('msg');

    // 读取全部设置
    chrome.storage.local.get(['pickcatBgUrl', 'pickcatMaskEnabled', 'pickcatCursor', 'pickcatCustomCursor'], (res) => {
        if (res.pickcatBgUrl) bgInput.value = res.pickcatBgUrl;
        maskToggle.checked = res.pickcatMaskEnabled !== undefined ? res.pickcatMaskEnabled : true;
        
        if (res.pickcatCursor) {
            cursorSelect.value = res.pickcatCursor;
            if (res.pickcatCursor === 'custom') {
                customCursorArea.style.display = 'block';
                if (res.pickcatCustomCursor) {
                    cursorPreview.innerHTML = `<img src="${res.pickcatCustomCursor}"> 已加载自定义指针`;
                }
            }
        }
    });

    // 下拉框切换显示上传区域
    cursorSelect.addEventListener('change', () => {
        customCursorArea.style.display = cursorSelect.value === 'custom' ? 'block' : 'none';
        // 如果切到了其他款式，直接触发保存并刷新
        chrome.storage.local.set({ pickcatCursor: cursorSelect.value }, () => {
            refreshPage();
        });
    });

    // 触发文件选择
    uploadCursorBtn.addEventListener('click', () => customCursorFile.click());

    // 处理本地图片：压缩为 32x32 并转 Base64
    customCursorFile.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = 32;  // 强制 32x32
                canvas.height = 32;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, 32, 32);
                
                const base64Data = canvas.toDataURL('image/png');
                
                // ★ 核心修改：上传完直接保存 + 切换到 custom 模式 + 刷新网页
                chrome.storage.local.set({ 
                    pickcatCustomCursor: base64Data,
                    pickcatCursor: 'custom'
                }, () => {
                    cursorPreview.innerHTML = `<img src="${base64Data}"> 图片已就绪，正在刷新...`;
                    msg.textContent = '✅ 指针已更新！';
                    refreshPage();
                });
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    });

    // 保存设置按钮
    saveBtn.addEventListener('click', () => {
        chrome.storage.local.set({ 
            pickcatBgUrl: bgInput.value.trim(),
            pickcatMaskEnabled: maskToggle.checked,
            pickcatCursor: cursorSelect.value
        }, () => {
            msg.textContent = '✅ 已保存，正在刷新...';
            refreshPage();
        });
    });

    // 快捷切换遮罩
    maskToggle.addEventListener('change', () => {
        chrome.storage.local.set({ pickcatMaskEnabled: maskToggle.checked }, () => {
            refreshPage();
        });
    });

    // 清空背景
    clearBtn.addEventListener('click', () => {
        bgInput.value = '';
        chrome.storage.local.set({ pickcatBgUrl: '' }, () => {
            msg.textContent = '✅ 已恢复默认背景，正在刷新...';
            refreshPage();
        });
    });

    function refreshPage() {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) chrome.tabs.reload(tabs[0].id);
        });
        setTimeout(() => window.close(), 800);
    }
});