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
            state.terminalId = terminalInput.toUpperCase();
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
            await video.play();
        }
        state.stream.getVideoTracks().forEach(track => {
            track.addEventListener('ended', () => {
                if (!state.authenticated) return;
                triggerLockoutModal('Hardware Policy Violation (Camera Stream Ended)');
                dispatchBlurViolation('Hardware Policy Violation (Camera Stream Ended)');
            }, { once: true });
        });
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
    const wsUrl = CONFIG.WS_BASE + '/ws/proctor/' + cleanStudentName + '?terminal_id=' + encodeURIComponent(state.terminalId) + '&session_id=' + encodeURIComponent(state.sessionId || '');

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
    const lineCount = String(userCode || '').split('\n').length;
    consoleBody.textContent = '';
    const notice = document.createElement('div');
    notice.className = 'alert-text';
    notice.textContent = '[EVALUATOR]: Browser-side execution is disabled. Running untrusted candidate code inside the examination page is unsafe. Connect an isolated server-side sandbox runner to enable evaluation.';
    const detail = document.createElement('div');
    detail.textContent = '[WORKSPACE]: ' + lineCount + ' lines are saved in the local editor buffer; no code was executed.';
    consoleBody.append(notice, detail);
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
        state.totalIncidents = Number(data.total_incidents ?? state.logs.length);
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

    if (totalElem) totalElem.textContent = String(typeof state.totalIncidents === 'number' ? state.totalIncidents : state.logs.length);

    const uniqueStudents = new Set(state.logs.map(l => l.student_name).filter(Boolean));
    const activeCount = typeof serverActiveCount === 'number'
        ? serverActiveCount
        : 0;
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
