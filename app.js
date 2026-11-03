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
    examTimer: null,
    examDeadline: null,
    examTitle: 'LabLock Examination',
    examDurationMinutes: 60,
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
                state.examTitle = result.exam_title || 'LabLock Examination';
                state.examProblemStatement = result.problem_statement || '';
                state.examDurationMinutes = Number(result.duration_minutes) || 60;
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
            const examTitleDisplay = document.getElementById('examTitleDisplay');
            const examDurationDisplay = document.getElementById('examDurationDisplay');
            if (examTitleDisplay) examTitleDisplay.textContent = state.examTitle;
            if (examDurationDisplay) examDurationDisplay.textContent = 'Attempt duration: ' + state.examDurationMinutes + ' minutes';
            const problemDescription = document.querySelector('.problem-desc');
            if (problemDescription && state.examProblemStatement.trim()) {
                problemDescription.textContent = state.examProblemStatement;
                problemDescription.classList.add('configured-problem');
            }
            startAttemptCountdown();

            const cameraReady = await startWebcamProctoring();
            if (!cameraReady) {
                endCandidateSession();
                if (workspace) workspace.classList.remove('active');
                if (authGate) authGate.style.display = 'block';
                showAuthError('Camera access is required to begin a proctored examination. Allow camera access and sign in again.');
                if (authSubmit) authSubmit.disabled = false;
                return;
            }
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
                    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
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
            codeArea.value = '# Write your solution here';
            codeArea.dispatchEvent(new Event('input'));
            appendConsoleOutput('[WORKSPACE]: Code buffer reset to initial skeleton.');
        });
    }
}

function endCandidateSession() {
    if (state.sampleTimer) clearInterval(state.sampleTimer);
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.sessionHeartbeatTimer) clearInterval(state.sessionHeartbeatTimer);
    if (state.examTimer) clearInterval(state.examTimer);
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

function startAttemptCountdown() {
    if (state.examTimer) clearInterval(state.examTimer);
    state.examDeadline = Date.now() + state.examDurationMinutes * 60 * 1000;
    const display = document.getElementById('workspaceTimer');
    const update = () => {
        const remaining = Math.max(0, state.examDeadline - Date.now());
        const totalSeconds = Math.ceil(remaining / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        if (display) display.textContent = 'Time remaining: ' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
        if (remaining <= 0 && state.examTimer) {
            clearInterval(state.examTimer);
            state.examTimer = null;
            if (display) display.textContent = 'Time expired · awaiting server confirmation';
        }
    };
    update();
    state.examTimer = setInterval(update, 1000);
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
                const reason = 'Hardware Policy Violation (Camera Stream Ended)';
                triggerLockoutModal(reason);
                dispatchBlurViolation(reason);
                state.authenticated = false;
                endCandidateSession();
                const banner = document.getElementById('securityBanner');
                const bannerText = document.getElementById('securityBannerText');
                if (bannerText) bannerText.textContent = 'Camera stream ended. This attempt has been stopped; contact the invigilator.';
                if (banner) banner.classList.add('active');
            }, { once: true });
        });
        appendConsoleOutput('[HARDWARE]: MediaDevices camera stream initialized.');
    } catch (err) {
        appendConsoleOutput('[HARDWARE ERROR]: Camera access failed (' + err.message + ').', 'alert-text');
        appendConsoleOutput('[SECURITY]: Examination was not started because camera access is required.', 'alert-text');
        return false;
    }

    connectProctorWebSocket(video, canvas, statusIndicator, statusText);
    return true;
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
                } else if (response.status === 'SESSION_ENDED') {
                    const banner = document.getElementById('securityBanner');
                    const bannerText = document.getElementById('securityBannerText');
                    if (bannerText) bannerText.textContent = response.message || 'This examination attempt has ended.';
                    if (banner) banner.classList.add('active');
                    state.authenticated = false;
                    endCandidateSession();
                }
            } catch (parseErr) {
                console.error('Invalid WebSocket payload received:', event.data);
            }
        };

        state.ws.onerror = () => {
            if (statusIndicator) statusIndicator.className = 'pulse-indicator alert';
            if (statusText) statusText.textContent = 'Connection Error';
        };

        state.ws.onclose = (event) => {
            if (statusIndicator) statusIndicator.className = 'pulse-indicator alert';
            if (statusText) statusText.textContent = 'Disconnected';
            if (event && event.code === 1008) {
                state.authenticated = false;
                const banner = document.getElementById('securityBanner');
                const bannerText = document.getElementById('securityBannerText');
                if (bannerText) bannerText.textContent = 'The examination session was closed or expired. Contact the invigilator.';
                if (banner) banner.classList.add('active');
                endCandidateSession();
            }
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
        session_id: state.sessionId,
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
    const authGate = document.getElementById('facultyAuthGate');
    const dashboard = document.getElementById('facultyDashboard');
    const authForm = document.getElementById('facultyAuthForm');
    if (authForm) {
        authForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const pin = document.getElementById('facultyDashboardPin').value;
            const error = document.getElementById('facultyAuthError');
            try {
                const response = await fetch(CONFIG.API_BASE + '/faculty/unlock', {
                    method: 'POST', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pin })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.detail || 'Faculty authorization failed.');
                if (authGate) authGate.style.display = 'none';
                if (dashboard) dashboard.style.display = 'block';
                fetchAuditLogs();
                loadExamConfiguration();
                loadCandidateRoster();
                loadFacultySessions();
                if (!state.pollTimer) state.pollTimer = setInterval(() => {
                    if (!document.hidden) fetchAuditLogs();
                }, CONFIG.POLL_INTERVAL_MS);
            } catch (authErr) {
                if (error) { error.textContent = authErr.message || 'Faculty authorization failed.'; error.style.display = 'block'; }
            }
        });
    }
    if (searchInput) searchInput.addEventListener('input', () => renderFilteredLogs());
    if (filterSelect) filterSelect.addEventListener('change', () => renderFilteredLogs());
    if (refreshBtn) refreshBtn.addEventListener('click', () => fetchAuditLogs());
    const examForm = document.getElementById('examConfigForm');
    if (examForm) examForm.addEventListener('submit', saveExamConfiguration);
    const candidateForm = document.getElementById('candidateForm');
    if (candidateForm) candidateForm.addEventListener('submit', addRosterCandidate);
    const sessionsRefresh = document.getElementById('refreshSessionsBtn');
    if (sessionsRefresh) sessionsRefresh.addEventListener('click', loadFacultySessions);
    const rosterBody = document.getElementById('rosterTableBody');
    if (rosterBody) rosterBody.addEventListener('click', handleRosterAction);
    const sessionBody = document.getElementById('sessionTableBody');
    if (sessionBody) sessionBody.addEventListener('click', handleSessionAction);
    const logoutBtn = document.getElementById('facultyLogoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', async () => {
        try { await facultyApi('/faculty/logout', { method: 'POST' }); } catch (error) { console.warn('Faculty logout request failed:', error); }
        if (state.pollTimer) clearInterval(state.pollTimer);
        state.pollTimer = null;
        const gate = document.getElementById('facultyAuthGate');
        const panel = document.getElementById('facultyDashboard');
        if (panel) panel.style.display = 'none';
        if (gate) gate.style.display = 'block';
        const pin = document.getElementById('facultyDashboardPin');
        if (pin) pin.value = '';
    });
    const resetBtn = document.getElementById('resetDashboardBtn');
    if (resetBtn) resetBtn.addEventListener('click', () => {
        const search = document.getElementById('searchInput');
        const filter = document.getElementById('violationFilter');
        if (search) search.value = '';
        if (filter) filter.value = 'ALL';
        renderFilteredLogs();
        fetchAuditLogs();
    });
    document.querySelectorAll('[data-dashboard-tab]').forEach(tab => {
        tab.addEventListener('click', () => {
            const setup = tab.dataset.dashboardTab === 'setup';
            document.querySelectorAll('[data-dashboard-tab]').forEach(item => {
                const active = item === tab;
                item.classList.toggle('active', active);
                item.setAttribute('aria-selected', String(active));
            });
            const monitoringPanel = document.getElementById('monitoringPanel');
            const setupPanel = document.getElementById('setupPanel');
            if (monitoringPanel) monitoringPanel.hidden = setup;
            if (setupPanel) setupPanel.hidden = !setup;
            if (setup) {
                loadExamConfiguration();
                loadCandidateRoster();
                loadFacultySessions();
            }
        });
    });
}

async function fetchAuditLogs() {
    try {
        const response = await fetch(CONFIG.API_BASE + '/get-logs', {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            credentials: 'include'
        });
        if (response.status === 401) {
            const gate = document.getElementById('facultyAuthGate');
            const dashboard = document.getElementById('facultyDashboard');
            if (gate) gate.style.display = 'block';
            if (dashboard) dashboard.style.display = 'none';
            if (state.pollTimer) clearInterval(state.pollTimer);
            state.pollTimer = null;
            return;
        }
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        state.logs = Array.isArray(data.logs) ? data.logs : [];
        loadFacultySessions();
        state.totalIncidents = Number(data.total_incidents ?? state.logs.length);
        updateDashboardCounters(data.active_terminals);
        renderDashboardVisuals(data.active_terminals);
        renderFilteredLogs(false);
    } catch (err) {
        updateDashboardCounters(0);
        renderDashboardVisuals(0);
        const connection = document.getElementById('dashboardConnection');
        if (connection) connection.innerHTML = '<span class="pulse-indicator alert"></span> Backend unavailable';
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

function renderDashboardVisuals(activeCount) {
    const updated = document.getElementById('dashboardUpdated');
    if (updated) updated.textContent = new Date().toLocaleTimeString();
    const connection = document.getElementById('dashboardConnection');
    if (connection) connection.innerHTML = '<span class="pulse-indicator"></span> Live · auto refresh 2s';

    const categories = [
        { key: 'phone', label: 'Mobile phone', css: 'phone' },
        { key: 'blur', label: 'Terminal blur', css: 'blur' },
        { key: 'gaze', label: 'Off-screen gaze', css: 'gaze' },
        { key: 'absent', label: 'Candidate absent', css: 'absent' },
        { key: 'multiple', label: 'Multiple persons', css: 'multiple' }
    ];
    const counts = categories.map(category => ({
        ...category,
        count: state.logs.filter(log => {
            const value = String(log.violation_type || '').toLowerCase();
            if (category.key === 'phone') return value.includes('phone');
            if (category.key === 'blur') return value.includes('blur') || value.includes('tab');
            if (category.key === 'gaze') return value.includes('gaze') || value.includes('off-screen');
            if (category.key === 'absent') return value.includes('absent') || value.includes('absence');
            return value.includes('multiple');
        }).length
    }));
    const maxCount = Math.max(1, ...counts.map(item => item.count));
    const categoryHost = document.getElementById('categoryBars');
    if (categoryHost) categoryHost.innerHTML = counts.map(item =>
        '<div class="category-row"><span class="category-name">' + item.label + '</span><div class="category-track"><div class="category-fill ' + item.css + '" style="width:' + (item.count ? Math.max(3, item.count / maxCount * 100) : 0) + '%"></div></div><span class="category-count">' + item.count + '</span></div>'
    ).join('');

    const trendHost = document.getElementById('trendBars');
    if (trendHost) {
        const now = Date.now();
        const buckets = Array.from({ length: 12 }, (_, index) => {
            const start = now - (11 - index) * 60 * 60 * 1000;
            return { hour: new Date(start).getHours(), count: 0 };
        });
        state.logs.forEach(log => {
            const stamp = new Date(String(log.timestamp || '').replace(' ', 'T'));
            if (Number.isNaN(stamp.getTime())) return;
            const ageHours = (now - stamp.getTime()) / 3600000;
            if (ageHours >= 0 && ageHours < 12) {
                const index = 11 - Math.floor(ageHours);
                if (buckets[index]) buckets[index].count++;
            }
        });
        const max = Math.max(1, ...buckets.map(item => item.count));
        trendHost.innerHTML = buckets.map(item =>
            '<div class="trend-column"><div class="trend-bar ' + (item.count ? 'has-events' : '') + '" style="height:' + Math.max(3, item.count / max * 100) + '%" title="' + item.count + ' incidents"></div><span class="trend-label">' + String(item.hour).padStart(2, '0') + '</span></div>'
        ).join('');
    }

    const seated = document.getElementById('seatedCandidates');
    const seatedCount = document.getElementById('seatedCount');
    const active = Number(activeCount) || 0;
    if (seatedCount) seatedCount.textContent = active + ' active';
    if (seated) seated.textContent = active
        ? active + ' terminal' + (active === 1 ? ' is' : 's are') + ' reporting a recent heartbeat. Candidate names are not included in the current API response.'
        : 'No candidates are currently seated at a proctored terminal.';

    const recent = document.getElementById('recentActivity');
    if (recent) {
        const latest = [...state.logs].slice(0, 5);
        recent.innerHTML = latest.length ? latest.map(log =>
            '<div class="activity-item"><div class="activity-main"><strong>' + escapeHtml(log.student_name || 'Unknown candidate') + '</strong><span>' + escapeHtml(log.timestamp || 'Timestamp unavailable') + ' · #' + escapeHtml(String(log.id || '')) + '</span></div><span class="activity-tag">' + escapeHtml(log.violation_type || 'Incident') + '</span></div>'
        ).join('') : '<div class="empty-panel">No incident records yet.</div>';
    }
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

async function facultyApi(path, options = {}) {
    const response = await fetch(CONFIG.API_BASE + path, {
        credentials: 'include',
        headers: { 'Accept': 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
        ...options
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || 'Faculty request failed (' + response.status + ').');
    return payload;
}

function formatDateTimeLocal(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return localDate.toISOString().slice(0, 16);
}

async function loadExamConfiguration() {
    try {
        const config = await facultyApi('/faculty/exam');
        const title = document.getElementById('examTitleInput');
        const problem = document.getElementById('examProblemInput');
        const duration = document.getElementById('examDurationInput');
        const status = document.getElementById('examStatusInput');
        const start = document.getElementById('examStartInput');
        const end = document.getElementById('examEndInput');
        if (title) title.value = config.title || '';
        if (problem) problem.value = config.problem_statement || '';
        if (duration) duration.value = config.duration_minutes || 60;
        if (status) status.value = config.status || 'OPEN';
        if (start) start.value = config.starts_at ? formatDateTimeLocal(config.starts_at) : '';
        if (end) end.value = config.ends_at ? formatDateTimeLocal(config.ends_at) : '';
    } catch (error) {
        const feedback = document.getElementById('examConfigFeedback');
        if (feedback) feedback.textContent = error.message;
    }
}

async function saveExamConfiguration(event) {
    event.preventDefault();
    const feedback = document.getElementById('examConfigFeedback');
    const payload = {
        title: document.getElementById('examTitleInput').value.trim(),
        problem_statement: document.getElementById('examProblemInput').value.trim(),
        duration_minutes: Number(document.getElementById('examDurationInput').value),
        status: document.getElementById('examStatusInput').value,
        starts_at: document.getElementById('examStartInput').value ? new Date(document.getElementById('examStartInput').value).toISOString() : null,
        ends_at: document.getElementById('examEndInput').value ? new Date(document.getElementById('examEndInput').value).toISOString() : null
    };
    if (payload.starts_at && payload.ends_at && new Date(payload.ends_at) <= new Date(payload.starts_at)) {
        if (feedback) feedback.textContent = 'The scheduled end must be later than the scheduled start.';
        return;
    }
    try {
        await facultyApi('/faculty/exam', { method: 'PUT', body: JSON.stringify(payload) });
        if (feedback) feedback.textContent = 'Examination settings saved.';
    } catch (error) {
        if (feedback) feedback.textContent = error.message;
    }
}

async function loadCandidateRoster() {
    const body = document.getElementById('rosterTableBody');
    if (!body) return;
    try {
        const data = await facultyApi('/faculty/candidates');
        const candidates = Array.isArray(data.candidates) ? data.candidates : [];
        const count = document.getElementById('rosterCount');
        if (count) count.textContent = candidates.filter(item => item.active).length + ' active / ' + candidates.length + ' total';
        body.innerHTML = candidates.length ? candidates.map(candidate =>
            '<tr><td><strong>' + escapeHtml(candidate.student_name) + '</strong></td><td class="mono">' + escapeHtml(candidate.terminal_id) + '</td><td><span class="session-status ' + (candidate.active ? 'active' : '') + '">' + (candidate.active ? 'Active' : 'Inactive') + '</span></td><td>' + (candidate.active ? '<button class="table-action" data-roster-id="' + Number(candidate.id) + '" type="button">Deactivate</button>' : '—') + '</td></tr>'
        ).join('') : '<tr><td colspan="4" class="empty-state">No roster entries. Candidate login remains open to any valid PIN/name/seat until a roster is created.</td></tr>';
    } catch (error) {
        body.innerHTML = '<tr><td colspan="4" class="empty-state">' + escapeHtml(error.message) + '</td></tr>';
    }
}

async function addRosterCandidate(event) {
    event.preventDefault();
    const feedback = document.getElementById('rosterFeedback');
    const name = document.getElementById('rosterNameInput').value.trim();
    const terminal = document.getElementById('rosterTerminalInput').value.trim();
    try {
        await facultyApi('/faculty/candidates', {
            method: 'POST',
            body: JSON.stringify({ student_name: name, terminal_id: terminal })
        });
        document.getElementById('candidateForm').reset();
        if (feedback) feedback.textContent = 'Candidate registered and seat allocated.';
        await loadCandidateRoster();
    } catch (error) {
        if (feedback) feedback.textContent = error.message;
    }
}

async function handleRosterAction(event) {
    const button = event.target.closest('[data-roster-id]');
    if (!button) return;
    if (!window.confirm('Deactivate this candidate roster entry? They will no longer be able to sign in.')) return;
    try {
        await facultyApi('/faculty/candidates/' + Number(button.dataset.rosterId), { method: 'DELETE' });
        await loadCandidateRoster();
    } catch (error) {
        const feedback = document.getElementById('rosterFeedback');
        if (feedback) feedback.textContent = error.message;
    }
}

async function loadFacultySessions() {
    const body = document.getElementById('sessionTableBody');
    if (!body) return;
    try {
        const data = await facultyApi('/faculty/sessions');
        const sessions = Array.isArray(data.sessions) ? data.sessions : [];
        const activeSessions = sessions.filter(session => session.status === 'ACTIVE');
        const seatedCount = document.getElementById('seatedCount');
        const seatedHost = document.getElementById('seatedCandidates');
        if (seatedCount) seatedCount.textContent = activeSessions.length + ' active';
        if (seatedHost) seatedHost.innerHTML = activeSessions.length ? activeSessions.map(session =>
            '<div class="activity-item"><div class="activity-main"><strong>' + escapeHtml(session.student_name) + '</strong><span>' + escapeHtml(session.terminal_id) + ' · Started ' + escapeHtml(session.started_at || '—') + '</span></div><span class="activity-tag">ACTIVE</span></div>'
        ).join('') : 'No candidates are currently seated at a proctored terminal.';
        body.innerHTML = sessions.length ? sessions.map(session => {
            const status = String(session.status || 'UNKNOWN');
            const canFinalize = status === 'ACTIVE' || status === 'ENDED';
            return '<tr><td><strong>' + escapeHtml(session.student_name) + '</strong></td><td class="mono">' + escapeHtml(session.terminal_id) + '</td><td>' + escapeHtml(session.started_at || '—') + '</td><td>' + escapeHtml(session.last_seen_at || '—') + '</td><td><span class="session-status ' + (status === 'ACTIVE' ? 'active' : status === 'CANCELLED' ? 'cancelled' : '') + '">' + escapeHtml(status) + '</span></td><td>' + (canFinalize ? '<button class="table-action" data-session-id="' + escapeHtml(session.id) + '" data-final-status="COMPLETED" type="button">Complete</button> <button class="table-action" data-session-id="' + escapeHtml(session.id) + '" data-final-status="CANCELLED" type="button">Cancel</button>' : escapeHtml(session.completion_reason || 'Finalized')) + '</td></tr>';
        }).join('') : '<tr><td colspan="6" class="empty-state">No examination attempts have been recorded.</td></tr>';
    } catch (error) {
        body.innerHTML = '<tr><td colspan="6" class="empty-state">' + escapeHtml(error.message) + '</td></tr>';
    }
}

async function handleSessionAction(event) {
    const button = event.target.closest('[data-session-id]');
    if (!button) return;
    const status = button.dataset.finalStatus;
    if (!window.confirm('Mark this attempt as ' + status.toLowerCase() + '? This will end an active proctoring connection.')) return;
    try {
        await facultyApi('/faculty/sessions/' + encodeURIComponent(button.dataset.sessionId) + '/status', {
            method: 'POST',
            body: JSON.stringify({ status, reason: 'Finalized by faculty console' })
        });
        await loadFacultySessions();
        await fetchAuditLogs();
    } catch (error) {
        window.alert(error.message);
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
