/* LabLock Official Frontend Client (app.js)
   - Student Terminal Authentication Gate & Workspace Lifecycle
   - MediaDevices Webcam Acquisition & 1000ms Off-Screen Canvas JPEG Encoding
   - Persistent WebSocket Streaming to ws://127.0.0.1:8000/ws/proctor/{student_name}
   - Window Blur / Alt+Tab Event Detection & HTTP POST to http://127.0.0.1:8000/log-violation
   - Discreet Lockout Modal with Unassisted Faculty PIN Verification
   - Faculty Invigilation Console Polling (http://127.0.0.1:8000/get-logs) every 2000ms
*/

// Universal host configuration: works when served by FastAPI (:8000), LAN IP, or opened directly as a local file
const isDirectFileOrExternalDev = (
    window.location.protocol === 'file:' ||
    window.location.origin === 'null' ||
    !window.location.host ||
    window.location.port === '5500' ||
    window.location.port === '3000'
);
const isSecure = window.location.protocol === 'https:';
const resolvedApiBase = isDirectFileOrExternalDev ? 'http://127.0.0.1:8000' : window.location.origin;
const resolvedWsBase = isDirectFileOrExternalDev
    ? 'ws://127.0.0.1:8000'
    : ((isSecure ? 'wss://' : 'ws://') + window.location.host);

const CONFIG = {
    API_BASE: resolvedApiBase,
    WS_BASE: resolvedWsBase,
    POLL_INTERVAL_MS: 2000,
    SAMPLE_RATE_MS: 1000,
    FACULTY_PIN_HASH: 'f8638b979b2f4f793ddb6dbd197e0ee25a7a6ea32b0ae22f5e3c5d119d839e75' // SHA-256
};

const state = {
    authenticated: false,
    studentName: '',
    terminalId: '',
    stream: null,
    ws: null,
    sampleTimer: null,
    pollTimer: null,
    isLocked: false,
    lockoutCount: 0,
    logs: [],
    sessionStartTime: null,
    sessionId: null,
    sessionHeartbeatTimer: null,
    reconnectTimer: null,
    totalViolations: 0,
    lastTableHtml: ''
};

document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('authGate') || document.getElementById('studentWorkspace')) {
        initStudentTerminal();
        initDraggableCamera();
    }
    if (document.getElementById('auditTable') || document.getElementById('facultyDashboard')) {
        initFacultyDashboard();
    }
});

// ==========================================
// Student Terminal Implementation (index.html)
// ==========================================

// ==========================================
// Floating Draggable & Resizable Camera Window
// ==========================================
function initDraggableCamera() {
    const windowElem = document.getElementById('floatingCameraWindow');
    const headerElem = document.getElementById('floatingCameraHeader');
    const hideBtn = document.getElementById('hideCameraBtn');
    const restoreBtn = document.getElementById('restoreCameraBtn');

    if (!windowElem || !headerElem) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    headerElem.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        const rect = windowElem.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        windowElem.style.bottom = 'auto';
        windowElem.style.right = 'auto';
        windowElem.style.left = initialLeft + 'px';
        windowElem.style.top = initialTop + 'px';

        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        let newLeft = initialLeft + dx;
        let newTop = initialTop + dy;

        const maxLeft = window.innerWidth - windowElem.offsetWidth;
        const maxTop = window.innerHeight - windowElem.offsetHeight;
        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
        newTop = Math.max(40, Math.min(newTop, maxTop));

        windowElem.style.left = newLeft + 'px';
        windowElem.style.top = newTop + 'px';
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
    });

    if (hideBtn && restoreBtn) {
        hideBtn.addEventListener('click', () => {
            windowElem.style.display = 'none';
            restoreBtn.style.display = 'inline-flex';
        });

        restoreBtn.addEventListener('click', () => {
            windowElem.style.display = 'flex';
            restoreBtn.style.display = 'none';
        });
    }
}

function initStudentTerminal() {
    const authForm = document.getElementById('authForm');
    const authGate = document.getElementById('authGate');
    const workspace = document.getElementById('studentWorkspace');
    const lockoutModal = document.getElementById('lockoutModal');
    const facultyPinForm = document.getElementById('facultyPinForm');
    const dismissBannerBtn = document.getElementById('dismissBannerBtn');
    const runCodeBtn = document.getElementById('runCodeBtn');
    const resetCodeBtn = document.getElementById('resetCodeBtn');
    const codeArea = document.getElementById('codeTextarea');

    if (authForm) {
        authForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const nameInput = document.getElementById('studentNameInput').value.trim();
            const terminalInput = document.getElementById('terminalIdInput').value.trim();
            const pinInput = document.getElementById('accessPinInput').value.trim();
            const authError = document.getElementById('authError');

            if (!nameInput || !terminalInput || !pinInput) {
                showAuthError('All credential fields are required for terminal authorization.');
                return;
            }

            if (pinInput.length < 4) {
                showAuthError('Invalid Access PIN. Please verify credentials with the presiding invigilator.');
                return;
            }

            if (authError) authError.style.display = 'none';
            const authSubmit = document.getElementById('authSubmitBtn');
            if (authSubmit) authSubmit.disabled = true;
            try {
                const response = await fetch(CONFIG.API_BASE + '/authenticate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ student_name: nameInput, terminal_id: terminalInput, pin: pinInput })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.detail || 'Candidate authentication failed.');
                state.sessionId = result.session_id;
            } catch (authErr) {
                showAuthError(authErr.message || 'Unable to authenticate with the examination server.');
                if (authSubmit) authSubmit.disabled = false;
                return;
            }

            state.studentName = nameInput;
            state.terminalId = terminalInput;
            state.authenticated = true;
            state.sessionStartTime = new Date();

            authGate.style.display = 'none';
            workspace.classList.add('active');

            const dispStudent = document.getElementById('displayStudentName');
            const dispTerminal = document.getElementById('displayTerminalId');
            if (dispStudent) dispStudent.textContent = state.studentName;
            if (dispTerminal) dispTerminal.textContent = state.terminalId;

            await startWebcamProctoring();
            initCodeEditor();
            setupSecurityListeners();
            if (state.sessionHeartbeatTimer) clearInterval(state.sessionHeartbeatTimer);
            state.sessionHeartbeatTimer = setInterval(() => {
                if (!state.sessionId) return;
                fetch(CONFIG.API_BASE + '/session/heartbeat', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: state.sessionId })
                }).catch(() => {});
            }, 15000);
            window.addEventListener('pagehide', endCandidateSession, { once: true });
        });
    }

    if (dismissBannerBtn) {
        dismissBannerBtn.addEventListener('click', () => {
            const banner = document.getElementById('securityBanner');
            if (banner) banner.classList.remove('active');
        });
    }

    if (facultyPinForm) {
        facultyPinForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const pinVal = document.getElementById('facultyPinInput').value.trim();
            const lockError = document.getElementById('lockoutError');

            try {
                const response = await fetch(CONFIG.API_BASE + '/faculty/unlock', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pin: pinVal })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.detail || 'Invalid Faculty Authorization PIN.');
                state.isLocked = false;
                lockoutModal.classList.remove('active');
                document.getElementById('facultyPinInput').value = '';
                if (lockError) lockError.style.display = 'none';
                appendConsoleOutput('[SECURITY RESTORED]: Faculty authorization verified by backend.', 'success');
            } catch (authErr) {
                if (lockError) {
                    lockError.textContent = authErr.message || 'Faculty verification failed.';
                    lockError.style.display = 'block';
                }
            }
        });
    }

    if (runCodeBtn && codeArea) {
        runCodeBtn.addEventListener('click', () => {
            runEvaluationSuite(codeArea.value);
        });
    }

    if (resetCodeBtn && codeArea) {
        resetCodeBtn.addEventListener('click', () => {
            codeArea.value = [
                'class LRUCache:',
                '    def __init__(self, capacity: int):',
                '        self.capacity = capacity',
                '        self.cache = {}',
                '',
                '    def get(self, key: int) -> int:',
                '        return self.cache.get(key, -1)',
                '',
                '    def put(self, key: int, value: int) -> None:',
                '        self.cache[key] = value'
            ].join('\n');
            codeArea.dispatchEvent(new Event('input'));
            appendConsoleOutput('[WORKSPACE]: Code buffer reset to initial skeleton.');
        });
    }
}

function endCandidateSession() {
    if (state.sampleTimer) clearInterval(state.sampleTimer);
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.sessionHeartbeatTimer) clearInterval(state.sessionHeartbeatTimer);
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.authenticated = false;
    if (state.ws && state.ws.readyState <= WebSocket.OPEN) state.ws.close(1000, 'Candidate session ended');
    if (state.stream) state.stream.getTracks().forEach(track => track.stop());
    state.stream = null;
    if (state.sessionId && navigator.sendBeacon) {
        const payload = new Blob([JSON.stringify({ session_id: state.sessionId })], { type: 'application/json' });
        navigator.sendBeacon(CONFIG.API_BASE + '/session/end', payload);
    }
    state.sessionId = null;
}

function showAuthError(msg) {
    const authError = document.getElementById('authError');
    if (authError) {
        authError.textContent = msg;
        authError.style.display = 'block';
    }
}

// ==========================================
// Webcam Sampling & WebSocket Streaming
// ==========================================
async function startWebcamProctoring() {
    const video = document.getElementById('webcamVideo');
    const canvas = document.getElementById('offscreenCanvas');
    const statusIndicator = document.getElementById('wsStatusIndicator');
    const statusText = document.getElementById('wsStatusText');

    try {
        state.stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 320, height: 240, frameRate: { ideal: 15 } },
            audio: false
        });
        if (video) {
            video.srcObject = state.stream;
        }
        appendConsoleOutput('[HARDWARE]: MediaDevices camera stream initialized.');
    } catch (err) {
        appendConsoleOutput('[HARDWARE ERROR]: Camera access failed (' + err.message + ').', 'alert-text');
        triggerLockoutModal('Hardware Policy Violation (Camera Unreachable)');
        dispatchBlurViolation('Hardware Policy Violation (Camera Unreachable)');
        return;
    }

    connectProctorWebSocket(video, canvas, statusIndicator, statusText);
}

function connectProctorWebSocket(video, canvas, statusIndicator, statusText) {
    const cleanStudentName = encodeURIComponent(state.studentName);
    const wsUrl = CONFIG.WS_BASE + '/ws/proctor/' + cleanStudentName + '?terminal_id=' + encodeURIComponent(state.terminalId);

    try {
        state.ws = new WebSocket(wsUrl);

        state.ws.onopen = () => {
            if (statusIndicator) statusIndicator.className = 'pulse-indicator';
            if (statusText) statusText.textContent = 'Connected (1000ms)';
            appendConsoleOutput('[PROCTOR ENGINE]: Connected to ' + wsUrl, 'success');
            startSamplingLoop(video, canvas);
        };

        state.ws.onmessage = (event) => {
            try {
                const response = JSON.parse(event.data);
                if (response.status === 'VIOLATION') {
                    const messages = Array.isArray(response.messages) ? response.messages : [response.message || 'Policy Non-Compliance Detected'];
                    messages.forEach(handleViolationAlert);
                }
            } catch (parseErr) {
                console.error('Invalid WebSocket payload received:', event.data);
            }
        };

        state.ws.onerror = () => {
            if (statusIndicator) statusIndicator.className = 'pulse-indicator alert';
            if (statusText) statusText.textContent = 'Connection Error';
        };

        state.ws.onclose = () => {
            if (statusIndicator) statusIndicator.className = 'pulse-indicator alert';
            if (statusText) statusText.textContent = 'Disconnected';
            if (state.sampleTimer) {
                clearInterval(state.sampleTimer);
                state.sampleTimer = null;
            }
            if (state.authenticated && !state.reconnectTimer) {
                state.reconnectTimer = setTimeout(() => {
                    state.reconnectTimer = null;
                    if (state.authenticated && (!state.ws || state.ws.readyState === WebSocket.CLOSED)) {
                        connectProctorWebSocket(video, canvas, statusIndicator, statusText);
                    }
                }, 3000);
            }
        };
    } catch (wsErr) {
        if (statusIndicator) statusIndicator.className = 'pulse-indicator alert';
        if (statusText) statusText.textContent = 'Offline';
    }
}

function startSamplingLoop(videoElement, canvasElement) {
    if (state.sampleTimer) clearInterval(state.sampleTimer);

    state.sampleTimer = setInterval(() => {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
        if (state.isLocked) return;
        if (state.ws.bufferedAmount > 1_000_000) return;

        if (videoElement && canvasElement && videoElement.videoWidth) {
            const ctx = canvasElement.getContext('2d');
            canvasElement.width = videoElement.videoWidth || 320;
            canvasElement.height = videoElement.videoHeight || 240;
            ctx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);

            const base64Data = canvasElement.toDataURL('image/jpeg', 0.7);
            state.ws.send(base64Data);
        }
    }, CONFIG.SAMPLE_RATE_MS);
}

function handleViolationAlert(violationText) {
    state.totalViolations++;
    const banner = document.getElementById('securityBanner');
    const bannerText = document.getElementById('securityBannerText');
    const countElem = document.getElementById('violationCountDisplay');

    if (banner && bannerText) {
        bannerText.textContent = 'PROCTORING ALERT: ' + violationText + '. Incident recorded in faculty audit log.';
        banner.classList.add('active');
    }

    if (countElem) {
        countElem.textContent = String(state.totalViolations);
    }

    appendConsoleOutput('[PROCTORING INCIDENT]: ' + violationText + ' (' + new Date().toLocaleTimeString() + ')', 'alert-text');
}

// ==========================================
// Window Blur / Tab Switch Security Policy
// ==========================================
function setupSecurityListeners() {
    window.addEventListener('blur', () => {
        if (!state.authenticated || state.isLocked) return;
        triggerLockoutModal('Terminal Blur / Tab Switch');
        dispatchBlurViolation('Terminal Blur / Tab Switch');
    });

    document.addEventListener('visibilitychange', () => {
        if (!state.authenticated || state.isLocked) return;
        if (document.visibilityState === 'hidden') {
            triggerLockoutModal('Terminal Blur / Tab Switch');
            dispatchBlurViolation('Terminal Blur / Tab Switch');
        }
    });

    window.addEventListener('keydown', (e) => {
        if (!state.authenticated) return;
        if (e.altKey && e.key === 'Tab') {
            e.preventDefault();
            if (!state.isLocked) {
                triggerLockoutModal('Terminal Blur / Tab Switch');
                dispatchBlurViolation('Terminal Blur / Tab Switch');
            }
        }
    });
}

async function dispatchBlurViolation(violationType) {
    const payload = {
        student_name: state.studentName,
        terminal_id: state.terminalId,
        violation_type: violationType
    };

    try {
        await fetch(CONFIG.API_BASE + '/log-violation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (err) {
        console.error('Failed to log violation to backend:', err);
    }
}

function triggerLockoutModal(reason) {
    state.isLocked = true;
    state.lockoutCount++;
    const modal = document.getElementById('lockoutModal');
    const timestampDisplay = document.getElementById('lockoutTimestamp');
    const reasonDisplay = document.getElementById('lockoutReason');

    if (timestampDisplay) {
        timestampDisplay.textContent = 'Incident Logged: ' + new Date().toLocaleString() + ' | Event: ' + reason;
    }
    if (reasonDisplay) {
        reasonDisplay.textContent = reason;
    }
    if (modal) {
        modal.classList.add('active');
    }

    handleViolationAlert(reason);
}

// ==========================================
// Distraction-Free Code Editor
// ==========================================
function initCodeEditor() {
    const textarea = document.getElementById('codeTextarea');
    const gutter = document.getElementById('lineGutter');
    if (!textarea || !gutter) return;

    function updateLineNumbers() {
        const lines = textarea.value.split('\n').length;
        let numbersHtml = '';
        for (let i = 1; i <= lines; i++) {
            numbersHtml += '<div>' + i + '</div>';
        }
        gutter.innerHTML = numbersHtml;
    }

    textarea.addEventListener('scroll', () => {
        gutter.scrollTop = textarea.scrollTop;
    });

    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            textarea.value = textarea.value.substring(0, start) + '    ' + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + 4;
            updateLineNumbers();
        } else if (e.key === 'Enter') {
            const start = textarea.selectionStart;
            const currentLine = textarea.value.substring(0, start).split('\n').pop();
            const match = currentLine.match(/^(\s+)/);
            if (match) {
                e.preventDefault();
                const indent = match[1];
                textarea.value = textarea.value.substring(0, start) + '\n' + indent + textarea.value.substring(start);
                textarea.selectionStart = textarea.selectionEnd = start + 1 + indent.length;
                updateLineNumbers();
            }
        }
    });

    textarea.addEventListener('input', updateLineNumbers);
    updateLineNumbers();
}

function runEvaluationSuite(userCode) {
    const consoleBody = document.getElementById('consoleBody');
    if (!consoleBody) return;

    const lineCount = userCode.split('\n').length;
    consoleBody.innerHTML = '<div>[COMPILER]: Analyzing buffer (' + lineCount + ' lines)...</div>';

    setTimeout(() => {
        // 1. Static Validation
        if (!userCode || userCode.trim().length === 0) {
            consoleBody.innerHTML += '<div class="alert-text">[COMPILER ERROR]: Buffer is empty. Please implement the LRUCache solution.</div>';
            consoleBody.innerHTML += '<div class="alert-text">[VERDICT]: 0/3 test cases passed. Compilation failed.</div>';
            return;
        }

        if (!userCode.includes('LRUCache')) {
            consoleBody.innerHTML += '<div class="alert-text">[COMPILER ERROR]: Missing required class definition "LRUCache".</div>';
            consoleBody.innerHTML += '<div class="alert-text">[VERDICT]: 0/3 test cases passed. Symbol not found.</div>';
            return;
        }

        const hasGet = /def\s+get\s*\(|get\s*\(/i.test(userCode);
        const hasPut = /def\s+put\s*\(|put\s*\(/i.test(userCode);

        if (!hasGet || !hasPut) {
            consoleBody.innerHTML += '<div class="alert-text">[COMPILER ERROR]: Required methods missing. LRUCache must implement both "get(key)" and "put(key, value)".</div>';
            consoleBody.innerHTML += '<div class="alert-text">[VERDICT]: 0/3 test cases passed. Incomplete interface.</div>';
            return;
        }

        // 2. Transpile and Extract Executable Class
        let RuntimeLRU = null;
        try {
            if (/class\s+LRUCache\s*\{/.test(userCode)) {
                // Code is already JavaScript
                const factory = new Function(userCode + '\n return (typeof LRUCache !== "undefined") ? LRUCache : null;');
                RuntimeLRU = factory();
            } else {
                // Transpile Python to executable JavaScript
                const jsCode = transpilePythonToJsClass(userCode);
                const factory = new Function(jsCode + '\n return (typeof LRUCache !== "undefined") ? LRUCache : null;');
                RuntimeLRU = factory();
            }
        } catch (compileErr) {
            consoleBody.innerHTML += '<div class="alert-text">[SYNTAX / COMPILATION ERROR]: ' + escapeHtml(compileErr.message) + '</div>';
            consoleBody.innerHTML += '<div class="alert-text">[VERDICT]: 0/3 test cases passed. Compilation failed.</div>';
            return;
        }

        if (!RuntimeLRU) {
            consoleBody.innerHTML += '<div class="alert-text">[COMPILER ERROR]: Could not instantiate LRUCache class from submitted code.</div>';
            consoleBody.innerHTML += '<div class="alert-text">[VERDICT]: 0/3 test cases passed.</div>';
            return;
        }

        consoleBody.innerHTML += '<div>[EVALUATOR]: Running Unit Test Suite (3 Test Cases)...</div>';

        let passedCount = 0;

        // --- TEST CASE 1: Sequential Insert & Eviction Limit ---
        try {
            const lru1 = new RuntimeLRU(2);
            lru1.put(1, 1);
            lru1.put(2, 2);
            const r1 = lru1.get(1);     // Expected: 1
            lru1.put(3, 3);             // Should evict key 2
            const r2 = lru1.get(2);     // Expected: -1 (evicted)
            lru1.put(4, 4);             // Should evict key 1
            const r3 = lru1.get(1);     // Expected: -1 (evicted)
            const r4 = lru1.get(3);     // Expected: 3
            const r5 = lru1.get(4);     // Expected: 4

            if (r1 === 1 && r2 === -1 && r3 === -1 && r4 === 3 && r5 === 4) {
                consoleBody.innerHTML += '<div class="success">[PASS]: Test Case 1: Sequential Insert & Capacity Eviction (12ms)</div>';
                passedCount++;
            } else {
                let failures = [];
                if (r1 !== 1) failures.push('get(1) returned ' + r1 + ', expected 1');
                if (r2 !== -1) failures.push('get(2) returned ' + r2 + ', expected -1 (key 2 was not evicted)');
                if (r3 !== -1) failures.push('get(1) returned ' + r3 + ', expected -1 (key 1 was not evicted)');
                if (r4 !== 3) failures.push('get(3) returned ' + r4 + ', expected 3');
                if (r5 !== 4) failures.push('get(4) returned ' + r5 + ', expected 4');
                consoleBody.innerHTML += '<div class="alert-text">[FAIL]: Test Case 1: Sequential Insert & Capacity Eviction</div>';
                consoleBody.innerHTML += '<div class="alert-text">  Mistake: ' + failures.join('; ') + '</div>';
            }
        } catch (e1) {
            consoleBody.innerHTML += '<div class="alert-text">[FAIL]: Test Case 1 Threw Exception: ' + escapeHtml(e1.message) + '</div>';
        }

        // --- TEST CASE 2: Key Update & Recency Overwrite ---
        try {
            const lru2 = new RuntimeLRU(2);
            lru2.put(1, 10);
            lru2.put(2, 20);
            lru2.put(1, 15);            // Update key 1 -> 15. Key 1 is now MRU; Key 2 is LRU.
            lru2.put(3, 30);            // Capacity exceeded. Should evict Key 2, NOT Key 1!
            const t2_evicted = lru2.get(2); // Expected: -1
            const t2_updated = lru2.get(1); // Expected: 15

            if (t2_evicted === -1 && t2_updated === 15) {
                consoleBody.innerHTML += '<div class="success">[PASS]: Test Case 2: Update Existing Key Preserves LRU Priority (8ms)</div>';
                passedCount++;
            } else {
                consoleBody.innerHTML += '<div class="alert-text">[FAIL]: Test Case 2: Key Update Recency Policy</div>';
                consoleBody.innerHTML += '<div class="alert-text">  Mistake: Overwriting key 1 failed to update its recency or value. get(2)=' + t2_evicted + ' (expected -1), get(1)=' + t2_updated + ' (expected 15).</div>';
            }
        } catch (e2) {
            consoleBody.innerHTML += '<div class="alert-text">[FAIL]: Test Case 2 Threw Exception: ' + escapeHtml(e2.message) + '</div>';
        }

        // --- TEST CASE 3: Read Recency Promotion on get() ---
        try {
            const lru3 = new RuntimeLRU(2);
            lru3.put(1, 100);
            lru3.put(2, 200);
            const val = lru3.get(1);    // Access key 1. Key 1 is now MRU; Key 2 is now LRU!
            lru3.put(3, 300);           // Capacity exceeded. Must evict Key 2, NOT Key 1!
            const t3_k2 = lru3.get(2);  // Expected: -1 (evicted)
            const t3_k1 = lru3.get(1);  // Expected: 100

            if (val === 100 && t3_k2 === -1 && t3_k1 === 100) {
                consoleBody.innerHTML += '<div class="success">[PASS]: Test Case 3: Read Recency Promotion on get() (9ms)</div>';
                passedCount++;
            } else {
                consoleBody.innerHTML += '<div class="alert-text">[FAIL]: Test Case 3: Read Recency Promotion on get()</div>';
                consoleBody.innerHTML += '<div class="alert-text">  Mistake: Calling get(1) did not promote key 1 to most recently used. get(2)=' + t3_k2 + ' (expected -1), get(1)=' + t3_k1 + ' (expected 100).</div>';
            }
        } catch (e3) {
            consoleBody.innerHTML += '<div class="alert-text">[FAIL]: Test Case 3 Threw Exception: ' + escapeHtml(e3.message) + '</div>';
        }

        consoleBody.innerHTML += '<div>--------------------------------------------------</div>';
        if (passedCount === 3) {
            consoleBody.innerHTML += '<div class="success">[VERDICT]: All test cases passed (3/3). Solution verified.</div>';
        } else {
            consoleBody.innerHTML += '<div class="alert-text">[VERDICT]: Evaluation failed (' + passedCount + '/3 test cases passed). Mistakes detected in test cases.</div>';
        }
        consoleBody.scrollTop = consoleBody.scrollHeight;
    }, 300);
}

function transpilePythonToJsClass(pyCode) {
    const lines = pyCode.split('\n');
    let jsCode = '';
    let indentStack = [0];

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (line.trim().length === 0 || line.trim().startsWith('#')) continue;

        // Strip Python type annotations
        line = line.replace(/:\s*(?:int|str|float|bool|Node|None|Any)\b/g, '');
        line = line.replace(/\s*->\s*(?:int|str|float|bool|Node|None|Any)\s*:/g, ':');

        const indentMatch = line.match(/^(\s*)/);
        const indent = indentMatch ? indentMatch[1].length : 0;
        const trimmed = line.trim();

        while (indentStack.length > 1 && indent < indentStack[indentStack.length - 1]) {
            indentStack.pop();
            jsCode += '}\n';
        }

        let jsLine = trimmed;

        // class Definition
        if (/^class\s+([A-Za-z0-9_]+)\s*:/.test(jsLine)) {
            const className = jsLine.match(/^class\s+([A-Za-z0-9_]+)/)[1];
            jsCode += 'class ' + className + ' {\n';
            indentStack.push(indent + 4);
            continue;
        }

        // def __init__(self, ...)
        if (/^def\s+__init__\s*\(\s*self\s*,?\s*(.*?)\)\s*:/.test(jsLine)) {
            const args = jsLine.match(/^def\s+__init__\s*\(\s*self\s*,?\s*(.*?)\)\s*:/)[1];
            jsCode += 'constructor(' + args + ') {\n';
            indentStack.push(indent + 4);
            continue;
        }

        // def method(self, ...)
        if (/^def\s+([A-Za-z0-9_]+)\s*\(\s*self\s*,?\s*(.*?)\)\s*:/.test(jsLine)) {
            const m = jsLine.match(/^def\s+([A-Za-z0-9_]+)\s*\(\s*self\s*,?\s*(.*?)\)\s*:/);
            jsCode += m[1] + '(' + m[2] + ') {\n';
            indentStack.push(indent + 4);
            continue;
        }

        // Conversions
        jsLine = jsLine.replace(/\bself\b/g, 'this');
        jsLine = jsLine.replace(/\bNone\b/g, 'null');
        jsLine = jsLine.replace(/\bTrue\b/g, 'true');
        jsLine = jsLine.replace(/\bFalse\b/g, 'false');
        jsLine = jsLine.replace(/\bdel\s+(.*?)$/g, 'delete $1;');
        jsLine = jsLine.replace(/\blen\((.*?)\)/g, '((typeof $1 === "object" && !Array.isArray($1)) ? Object.keys($1).length : ($1).length)');
        jsLine = jsLine.replace(/\bNode\(/g, 'new Node(');

        // if / elif / else
        if (jsLine.startsWith('if ') && jsLine.endsWith(':')) {
            let cond = jsLine.substring(3, jsLine.length - 1).trim();
            cond = cond.replace(/\b(.*?)\s+in\s+(.*?)$/, '($1 in $2)');
            cond = cond.replace(/\b(.*?)\s+not in\s+(.*?)$/, '(!($1 in $2))');
            jsCode += 'if (' + cond + ') {\n';
            indentStack.push(indent + 4);
            continue;
        }
        if (jsLine.startsWith('elif ') && jsLine.endsWith(':')) {
            let cond = jsLine.substring(5, jsLine.length - 1).trim();
            cond = cond.replace(/\b(.*?)\s+in\s+(.*?)$/, '($1 in $2)');
            cond = cond.replace(/\b(.*?)\s+not in\s+(.*?)$/, '(!($1 in $2))');
            jsCode += 'else if (' + cond + ') {\n';
            indentStack.push(indent + 4);
            continue;
        }
        if (jsLine === 'else:') {
            jsCode += 'else {\n';
            indentStack.push(indent + 4);
            continue;
        }

        // Local variable assignment scoping
        if (/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=/.test(jsLine)) {
            const varName = jsLine.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/)[1];
            if (!['this', 'return'].includes(varName)) {
                jsLine = 'var ' + jsLine;
            }
        }

        jsCode += jsLine + ';\n';
    }

    while (indentStack.length > 1) {
        indentStack.pop();
        jsCode += '}\n';
    }
    return jsCode;
}

function appendConsoleOutput(msg, cssClass) {
    const consoleBody = document.getElementById('consoleBody');
    if (!consoleBody) return;
    const div = document.createElement('div');
    if (cssClass) div.className = cssClass;
    div.textContent = msg;
    consoleBody.appendChild(div);
    consoleBody.scrollTop = consoleBody.scrollHeight;
}

// ==========================================
// Faculty Invigilation Console (dashboard.html)
// ==========================================
function initFacultyDashboard() {
    const searchInput = document.getElementById('searchInput');
    const filterSelect = document.getElementById('violationFilter');
    const refreshBtn = document.getElementById('manualRefreshBtn');

    fetchAuditLogs();
    state.pollTimer = setInterval(() => { if (!document.hidden) fetchAuditLogs(); }, CONFIG.POLL_INTERVAL_MS);

    if (searchInput) {
        searchInput.addEventListener('input', () => renderFilteredLogs());
    }
    if (filterSelect) {
        filterSelect.addEventListener('change', () => renderFilteredLogs());
    }
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => fetchAuditLogs());
    }
}

async function fetchAuditLogs() {
    try {
        const response = await fetch(CONFIG.API_BASE + '/get-logs', {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        state.logs = Array.isArray(data.logs) ? data.logs : [];
        updateDashboardCounters(data.active_terminals);
        renderFilteredLogs(false);
    } catch (err) {
        updateDashboardCounters(0);
        renderFilteredLogs(true);
    }
}

function updateDashboardCounters(serverActiveCount) {
    const totalElem = document.getElementById('metricTotalIncidents');
    const terminalsElem = document.getElementById('metricActiveTerminals');
    const phoneElem = document.getElementById('metricPhoneViolations');
    const blurElem = document.getElementById('metricBlurViolations');

    if (totalElem) totalElem.textContent = String(state.logs.length);

    const uniqueStudents = new Set(state.logs.map(l => l.student_name).filter(Boolean));
    const activeCount = typeof serverActiveCount === 'number'
        ? Math.max(serverActiveCount, uniqueStudents.size)
        : uniqueStudents.size;
    if (terminalsElem) terminalsElem.textContent = String(activeCount);

    const phones = state.logs.filter(l => (l.violation_type || '').toLowerCase().includes('phone')).length;
    const blurs = state.logs.filter(l => {
        const v = (l.violation_type || '').toLowerCase();
        return v.includes('blur') || v.includes('tab');
    }).length;

    if (phoneElem) phoneElem.textContent = String(phones);
    if (blurElem) blurElem.textContent = String(blurs);
}

function renderFilteredLogs(isOffline) {
    const tbody = document.getElementById('auditTableBody');
    const searchInput = document.getElementById('searchInput');
    const filterSelect = document.getElementById('violationFilter');
    if (!tbody) return;

    const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';
    const filterType = filterSelect ? filterSelect.value : 'ALL';

    const filtered = state.logs.filter(item => {
        const studentName = (item.student_name || '').toLowerCase();
        const violationType = (item.violation_type || '').toLowerCase();
        const idStr = String(item.id || '');

        const matchesSearch = !searchTerm ||
            studentName.includes(searchTerm) ||
            violationType.includes(searchTerm) ||
            idStr.includes(searchTerm);

        const matchesType = (filterType === 'ALL') ||
            (filterType === 'PHONE' && violationType.includes('phone')) ||
            (filterType === 'BLUR' && (violationType.includes('blur') || violationType.includes('tab'))) ||
            (filterType === 'GAZE' && violationType.includes('off-screen'));

        return matchesSearch && matchesType;
    });

    if (filtered.length === 0) {
        const emptyText = isOffline && state.logs.length === 0
            ? 'Awaiting connection to FastAPI backend at http://127.0.0.1:8000/get-logs...'
            : 'No incident records found in the SQLite audit log.';
        const emptyRow = '<tr><td colspan="5" class="empty-state">' + escapeHtml(emptyText) + '</td></tr>';
        if (state.lastTableHtml !== emptyRow) {
            tbody.innerHTML = emptyRow;
            state.lastTableHtml = emptyRow;
        }
        return;
    }

    let rowsHtml = '';
    filtered.forEach(log => {
        let formattedTime = log.timestamp || '';
        try {
            const raw = String(log.timestamp || '');
            const isoStr = raw.includes('T') ? raw : raw.replace(' ', 'T') + (raw.endsWith('Z') ? '' : 'Z');
            const dateObj = new Date(isoStr);
            if (!isNaN(dateObj.getTime())) {
                formattedTime = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString();
            }
        } catch (e) {
            formattedTime = log.timestamp;
        }

        let pillClass = 'event-pill alert';
        if ((log.violation_type || '').toLowerCase().includes('blur')) {
            pillClass = 'event-pill warning';
        }

        rowsHtml += '<tr>' +
            '<td class="mono">#' + escapeHtml(String(log.id)) + '</td>' +
            '<td class="mono">' + escapeHtml(formattedTime) + '</td>' +
            '<td><strong>' + escapeHtml(log.student_name) + '</strong></td>' +
            '<td><span class="' + pillClass + '">' + escapeHtml(log.violation_type) + '</span></td>' +
            '<td><span style="font-size:12px; color:var(--ink-muted);">Logged in SQLite</span></td>' +
            '</tr>';
    });

    if (state.lastTableHtml !== rowsHtml) {
        tbody.innerHTML = rowsHtml;
        state.lastTableHtml = rowsHtml;
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, function(m) {
        return {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        }[m];
    });
}
