// ============================================================
// PTA Auto Solver v3.0 - Content Script
// ============================================================

let isRunning = false;
let currentRetry = 0;
let maxRetries = 5;
let stepDelay = 1000;
let hintMode = false;
let streamBuffer = '';
let streamResolve = null;
let streamPromise = null;

function checkCancelled() {
  if (!isRunning) throw new Error('任务已停止');
}

function sleep(ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const check = setInterval(() => {
      if (!isRunning) {
        clearInterval(check);
        clearTimeout(timer);
        reject(new Error('任务已停止'));
      }
    }, 200);
  });
}

function runInPage(jsCode) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('runInPage timeout')), 10000);
    chrome.runtime.sendMessage({ action: 'runInPage', code: jsCode }, (res) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('no response'));
      if (res.error) reject(new Error(res.error));
      else resolve(res.result);
    });
  });
}

async function setCode(code) {
  return runInPage(`
    var cmContent = document.querySelector('.cm-content[contenteditable="true"]');
    if (!cmContent) return {error:'no cm-content'};
    var container = cmContent.closest('.cm-editor').parentElement;
    var fk = null;
    for (var k in container) { if (k.startsWith('__reactFiber')) { fk = k; break; } }
    if (!fk) return {error:'no fiber'};
    var f = container[fk], view = null;
    for (var i = 0; i < 10 && f; i++) {
      if (f.stateNode && f.stateNode.codemirror && f.stateNode.codemirror.dispatch) { view = f.stateNode.codemirror; break; }
      if (f.ref && f.ref.current && f.ref.current.codemirror && f.ref.current.codemirror.dispatch) { view = f.ref.current.codemirror; break; }
      f = f.return;
    }
    if (!view) return {error:'no view'};
    view.focus();
    view.dispatch({changes:{from:0,to:view.state.doc.length,insert:${JSON.stringify(code)}}});
    return {ok:true, length:view.state.doc.length};
  `);
}

async function getCode() {
  return runInPage(`
    var cmContent = document.querySelector('.cm-content[contenteditable="true"]');
    return cmContent ? cmContent.textContent : null;
  `);
}

// ============================================================
// Problem Extraction
// ============================================================
function extractProblem() {
  const main = document.querySelector('main');
  if (!main) return null;

  const h3s = main.querySelectorAll('h3');
  const problem = { sections: {} };

  for (const h3 of h3s) {
    const id = h3.id;
    if (!id) continue;

    let content = '';
    let sibling = h3.nextElementSibling;
    while (sibling && sibling.tagName !== 'H3') {
      const cmContent = sibling.querySelector('.cm-content');
      if (cmContent) {
        content += cmContent.innerText;
      } else {
        content += sibling.textContent;
      }
      sibling = sibling.nextElementSibling;
    }
    problem.sections[id.replace('：', '')] = content.trim();
  }

  const text = main.textContent;
  const scoreMatch = text.match(/分数\s*(\d+)/);
  problem.score = scoreMatch ? parseInt(scoreMatch[1]) : null;
  problem.timeLimit = (text.match(/时间限制\s*(\d+)\s*ms/) || [])[1] || null;
  problem.memLimit = (text.match(/内存限制\s*(\d+)\s*MB/) || [])[1] || null;
  problem.codeLimit = (text.match(/代码长度限制\s*(\d+)\s*KB/) || [])[1] || null;
  problem.isFunctionProblem = !!document.querySelector('#tab-CODE_COMPLETION');
  problem.language = getCurrentLanguage();

  return problem;
}

// ============================================================
// Language Selection
// ============================================================
function getCurrentLanguage() {
  const el = document.querySelector('.select__single-value');
  return el ? el.textContent.trim() : null;
}

function setLanguage(lang) {
  const control = document.querySelector('.select__control');
  if (!control) return;
  control.click();
  setTimeout(() => {
    const options = document.querySelectorAll('.select__option');
    for (const opt of options) {
      if (opt.textContent.includes(lang)) {
        opt.click();
        break;
      }
    }
  }, 300);
}

// ============================================================
// Button Helpers
// ============================================================
function findButton(text) {
  return Array.from(document.querySelectorAll('button'))
    .find(b => b.textContent.trim() === text);
}

function clickButton(text) {
  const btn = findButton(text);
  if (btn && !btn.disabled) {
    btn.click();
    return true;
  }
  return false;
}

// ============================================================
// Tab / Test / Submit
// ============================================================
function clickTab(tabName) {
  const btn = findButton(tabName);
  if (btn) btn.click();
}

async function waitForTestResult() {
  clickTab('测试用例');
  await sleep(1500);
  const runBtn = findButton('运行测试');
  if (runBtn) runBtn.click();
  await sleep(5000);

  const answerInput = document.querySelector('[class*="answerInput"]');
  if (!answerInput) return { error: 'no answerInput' };

  const readOnlyEditors = answerInput.querySelectorAll('[class*="readOnly"]');
  const actual = readOnlyEditors[0]?.querySelector('.cm-content')?.textContent?.trim() || '';
  const expected = readOnlyEditors[1]?.querySelector('.cm-content')?.textContent?.trim() || '';

  if (!actual && !expected) {
    return { error: 'no test output' };
  }

  return { actual, expected, match: actual === expected };
}

function checkCompilerOutput() {
  clickTab('编译器输出');
  const answerInput = document.querySelector('[class*="answerInput"]');
  if (!answerInput) return { hasError: false, output: '' };

  const text = answerInput.innerText || '';
  const compilerIdx = text.indexOf('编译器输出');
  if (compilerIdx === -1) return { hasError: false, output: '' };

  const output = text.substring(compilerIdx).split('\n').slice(1).join('\n').trim();
  return { hasError: output !== '' && output !== '空', output };
}

async function submitAndWaitResult() {
  clickButton('提交本题作答');

  const pendingStatuses = ['等待评测', '评测中', '排队中'];
  const finalStatuses = ['答案正确', '答案错误', '编译错误', '运行超时',
    '段错误', '内存超限', '输出超限', '格式错误', '部分正确'];

  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const modal = document.querySelector('.modal_I0D4Y, [class*="pc-modal"]');
    if (!modal || modal.offsetHeight === 0) continue;

    const allText = modal.innerText;
    const statusMatch = allText.match(/状态\s*：?\s*(\S+)/);
    const status = statusMatch?.[1] || '未知';

    if (pendingStatuses.includes(status)) {
      continue;
    }

    if (!finalStatuses.includes(status) && i < 59) {
      continue;
    }

    const scoreMatch = allText.match(/分数\s*：?\s*([\d]+)\s*\/\s*([\d]+)/);
    const score = scoreMatch
      ? { earned: parseInt(scoreMatch[1]), total: parseInt(scoreMatch[2]) }
      : null;

    const timeMatch = allText.match(/用时\s*：?\s*([\d]+)\s*\/\s*([\d]+)\s*ms/);
    const memMatch = allText.match(/内存\s*：?\s*([\d]+)\s*\/\s*([\d]+)\s*KB/);

    const table = modal.querySelector('table');
    const testCases = table
      ? Array.from(table.querySelectorAll('tbody tr')).map(tr => {
          const cells = Array.from(tr.querySelectorAll('td'));
          return {
            id: cells[0]?.textContent?.trim(),
            memory: cells[2]?.textContent?.trim(),
            time: cells[3]?.textContent?.trim(),
            result: cells[4]?.textContent?.trim(),
            score: cells[5]?.textContent?.trim(),
          };
        })
      : [];

    const allCorrect = testCases.length > 0 && testCases.every(t => t.result === '答案正确');

    const closeBtn = modal.querySelector('button');
    if (closeBtn) closeBtn.click();
    await sleep(500);

    return {
      status,
      score,
      time: timeMatch ? `${timeMatch[1]}/${timeMatch[2]} ms` : null,
      memory: memMatch ? `${memMatch[1]}/${memMatch[2]} KB` : null,
      testCases,
      allCorrect,
      passed: status === '答案正确',
    };
  }
  return { error: 'submit modal timeout' };
}

// ============================================================
// Navigation
// ============================================================
function getProblemStatuses() {
  const links = Array.from(document.querySelectorAll('.px-2.grid a[href*="problemSetProblemId"]'));
  if (links.length === 0) {
    return Array.from(document.querySelectorAll('a[href*="problemSetProblemId"]'))
      .map(a => {
        const params = new URLSearchParams(a.href.split('?')[1]);
        const rect = a.querySelector('[class*="problemStatusRect"]');
        let status = 'no_answer';
        if (rect) {
          const cn = rect.className;
          if (cn.includes('PROBLEM_ACCEPTED')) status = 'accepted';
          else if (cn.includes('PROBLEM_WRONG_ANSWER')) status = 'wrong';
          else if (cn.includes('PROBLEM_SUBMITTED')) status = 'submitted';
        }
        return {
          num: a.textContent.trim(),
          problemId: params.get('problemSetProblemId'),
          status,
          isActive: a.classList.contains('active'),
        };
      });
  }
  return links.map(a => {
    const params = new URLSearchParams(a.href.split('?')[1]);
    const rect = a.querySelector('[class*="problemStatusRect"]');
    let status = 'no_answer';
    if (rect) {
      const cn = rect.className;
      if (cn.includes('PROBLEM_ACCEPTED')) status = 'accepted';
      else if (cn.includes('PROBLEM_WRONG_ANSWER')) status = 'wrong';
      else if (cn.includes('PROBLEM_SUBMITTED')) status = 'submitted';
    }
    return {
      num: a.textContent.trim(),
      problemId: params.get('problemSetProblemId'),
      status,
      isActive: a.classList.contains('active'),
    };
  });
}

function clickProblemById(problemId) {
  const link = document.querySelector(`a[href*="problemSetProblemId=${problemId}"]`);
  if (link) {
    link.click();
    return true;
  }
  return false;
}

function getCurrentProblemIndex() {
  const active = document.querySelector('a[href*="problemSetProblemId"].active');
  return active ? active.textContent.trim() : null;
}

function getUnACProblems() {
  return getProblemStatuses().filter(p => p.status !== 'accepted');
}

function findNextUnACProblem() {
  const problems = getProblemStatuses();
  const activeIndex = problems.findIndex(p => p.isActive);
  for (let i = activeIndex + 1; i < problems.length; i++) {
    if (problems[i].status !== 'accepted') return problems[i];
  }
  for (let i = 0; i < activeIndex; i++) {
    if (problems[i].status !== 'accepted') return problems[i];
  }
  return null;
}

function goToProblem(problemId) {
  const url = new URL(window.location.href);
  url.searchParams.set('problemSetProblemId', problemId);
  window.location.href = url.toString();
}

function waitForEditor(timeout = 15000) {
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if (!isRunning) { clearInterval(check); reject(new Error('任务已停止')); return; }
      const cm = document.querySelector('.cm-content[contenteditable="true"]');
      if (cm) { clearInterval(check); resolve(); }
    }, 300);
    setTimeout(() => { clearInterval(check); resolve(); }, timeout);
  });
}

function waitForStatusChange(problemId, timeout = 30000) {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const problems = getProblemStatuses();
      const current = problems.find(p => p.problemId === problemId);
      if (current && current.status !== 'submitted' && current.status !== 'wrong') {
        observer.disconnect();
        resolve(current.status);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
  });
}

function showUnACProblems() {
  const unAC = getUnACProblems();
  const el = document.getElementById('pta-unac');
  if (el) {
    el.textContent = unAC.length > 0 ? unAC.map(p => p.num).join(', ') : '无';
  }
}

// ============================================================
// AI Communication (Streaming)
// ============================================================
function requestAIStream(type, data) {
  streamBuffer = '';
  streamPromise = new Promise((resolve) => {
    streamResolve = resolve;
  });

  chrome.runtime.sendMessage({ type: type === 'generate' ? 'generateStream' : 'debugStream', data });

  return streamPromise;
}

function requestHintStream(data) {
  streamBuffer = '';
  streamPromise = new Promise((resolve) => {
    streamResolve = resolve;
  });

  chrome.runtime.sendMessage({ type: 'hintStream', data });

  return streamPromise;
}

function handleStreamChunk(chunk) {
  streamBuffer += chunk;
  appendCodeStream(chunk);
}

function handleStreamComplete(code) {
  if (streamResolve) {
    streamResolve({ code });
    streamResolve = null;
    streamPromise = null;
  }
}

function handleStreamError(error) {
  if (streamResolve) {
    streamResolve({ error });
    streamResolve = null;
    streamPromise = null;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'streamChunk') {
    handleStreamChunk(msg.chunk);
  } else if (msg.type === 'streamComplete') {
    handleStreamComplete(msg.code);
  } else if (msg.type === 'streamError') {
    handleStreamError(msg.error);
  }
});

async function requestAI(type, data) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AI 请求超时(30s)')), 30000);
    chrome.runtime.sendMessage({ type, data }, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.error) {
        reject(new Error(response.error));
      } else {
        resolve(response.code);
      }
    });
  });
}

// ============================================================
// AC Animation
// ============================================================
function showACAnimation() {
  const overlay = document.createElement('div');
  overlay.id = 'pta-ac-overlay';
  overlay.innerHTML = `
    <style>
      @keyframes ac-confetti-fall {
        0% { transform: translateY(-100vh) rotate(0deg); opacity: 1; }
        100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
      }
      @keyframes ac-text-pop {
        0% { transform: scale(0); opacity: 0; }
        50% { transform: scale(1.2); opacity: 1; }
        100% { transform: scale(1); opacity: 1; }
      }
      @keyframes ac-glow {
        0%, 100% { text-shadow: 0 0 10px #10b981, 0 0 20px #10b981, 0 0 30px #10b981; }
        50% { text-shadow: 0 0 20px #34d399, 0 0 40px #34d399, 0 0 60px #34d399; }
      }
      #pta-ac-overlay {
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        background: rgba(0,0,0,0.7); z-index: 999999;
        display: flex; align-items: center; justify-content: center; flex-direction: column;
      }
      #pta-ac-overlay .ac-text {
        font-size: 80px; font-weight: 900; color: #10b981;
        animation: ac-text-pop 0.6s ease-out, ac-glow 2s ease-in-out infinite;
        font-family: 'SF Mono', 'Consolas', monospace;
      }
      #pta-ac-overlay .ac-sub {
        font-size: 24px; color: #6ee7b7; margin-top: 16px;
        animation: ac-text-pop 0.8s ease-out;
      }
      #pta-ac-overlay .confetti {
        position: absolute; width: 10px; height: 10px;
        animation: ac-confetti-fall 3s ease-in forwards;
      }
    </style>
    <div class="ac-text">AC!</div>
    <div class="ac-sub">🎉 答案正确 🎉</div>
  `;

  const colors = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];
  for (let i = 0; i < 50; i++) {
    const confetti = document.createElement('div');
    confetti.className = 'confetti';
    confetti.style.left = Math.random() * 100 + 'vw';
    confetti.style.top = '-10px';
    confetti.style.background = colors[Math.floor(Math.random() * colors.length)];
    confetti.style.animationDelay = Math.random() * 2 + 's';
    confetti.style.animationDuration = (2 + Math.random() * 2) + 's';
    confetti.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
    confetti.style.width = (6 + Math.random() * 8) + 'px';
    confetti.style.height = (6 + Math.random() * 8) + 'px';
    overlay.appendChild(confetti);
  }

  document.body.appendChild(overlay);
  setTimeout(() => overlay.remove(), 3500);
}

// ============================================================
// Main Auto-Solve Loop
// ============================================================
async function autoSolve() {
  const config = await chrome.storage.sync.get(['maxRetries', 'stepDelay']);
  maxRetries = parseInt(config.maxRetries) || 5;
  stepDelay = parseInt(config.stepDelay) || 1000;

  isRunning = true;
  currentRetry = 0;
  let apiRetry = 0;
  const maxApiRetries = 3;

  let code = null;
  let problem = null;
  let currentProblemId = null;

  showUnACProblems();

  const urlParams = new URLSearchParams(window.location.search);
  const currentUrlProblemId = urlParams.get('problemSetProblemId');

  while (isRunning) {
    try {
      const unAC = getUnACProblems();
      if (unAC.length === 0) {
        updateStatus('🎉 全部题目已完成！');
        sessionStorage.removeItem('pta-auto-solve');
        isRunning = false;
        break;
      }

      const nextProblem = unAC[0];
      
      if (currentProblemId === null) {
        if (currentUrlProblemId === nextProblem.problemId) {
          currentProblemId = nextProblem.problemId;
        } else {
          updateStatus(`📌 跳转至题目 ${nextProblem.num}...`);
          sessionStorage.setItem('pta-auto-solve', 'running');
          goToProblem(nextProblem.problemId);
          return;
        }
      }

      if (nextProblem.problemId !== currentProblemId) {
        updateStatus(`📌 跳转至题目 ${nextProblem.num}...`);
        sessionStorage.setItem('pta-auto-solve', 'running');
        currentProblemId = nextProblem.problemId;
        currentRetry = 0;
        code = null;
        problem = null;

        goToProblem(nextProblem.problemId);
        return;
      }

      const langConfig = await chrome.storage.sync.get(['language']);
      checkCancelled();
      if (langConfig.language) {
        setLanguage(langConfig.language);
        await sleep(stepDelay);
        checkCancelled();
      }

      if (!code) {
        updateStatus('📖 读取题目...');
        problem = extractProblem();
        if (!problem) {
          updateStatus('⚠️ 未找到题目内容');
          await sleep(2000);
          break;
        }
        checkCancelled();
        updateProblemInfo(getCurrentProblemIndex());

        updateStatus('🤖 AI 生成代码中...');
        clearCodeDisplay();
        const aiResult = await requestAIStream('generate', { problem });
        if (aiResult.error) throw new Error(aiResult.error);
        code = aiResult.code;
        checkCancelled();
        apiRetry = 0;
      }

      updateStatus('📝 写入代码...');
      await setCode(code);
      checkCancelled();
      await sleep(stepDelay);
      checkCancelled();

      updateStatus('🔍 检查编译输出...');
      const compiler = checkCompilerOutput();
      if (compiler.hasError) {
        currentRetry++;
        updateStatus(`🔧 编译错误，第 ${currentRetry}/${maxRetries} 次重试`);
        updateRetryCount(currentRetry);
        if (currentRetry >= maxRetries) {
          updateStatus(`❌ 题目 ${getCurrentProblemIndex()} 重试用尽，跳过`);
          currentProblemId = null;
          currentRetry = 0;
          code = null;
          problem = null;
          showUnACProblems();
          continue;
        }
        updateStatus('🤖 AI 修复代码中...');
        clearCodeDisplay();
        const aiResult = await requestAIStream('debug', { code, problem, error: compiler.output, errorType: 'compile' });
        if (aiResult.error) throw new Error(aiResult.error);
        code = aiResult.code;
        checkCancelled();
        apiRetry = 0;
        continue;
      }

      updateStatus('🧪 运行测试...');
      const testResult = await waitForTestResult();
      checkCancelled();

      if (testResult.error) {
        updateStatus(`⚠️ 测试异常: ${testResult.error}`);
        currentRetry++;
        updateRetryCount(currentRetry);
        if (currentRetry >= maxRetries) {
          updateStatus(`❌ 题目 ${getCurrentProblemIndex()} 重试用尽，跳过`);
          currentProblemId = null;
          currentRetry = 0;
          code = null;
          problem = null;
          showUnACProblems();
          continue;
        }
        updateStatus('🤖 AI 修复代码中...');
        clearCodeDisplay();
        const aiResult = await requestAIStream('debug', { code, problem, testResult, errorType: 'test_error' });
        if (aiResult.error) throw new Error(aiResult.error);
        code = aiResult.code;
        checkCancelled();
        apiRetry = 0;
        continue;
      }

      if (!testResult.match) {
        currentRetry++;
        updateStatus(`🔧 测试不匹配，第 ${currentRetry}/${maxRetries} 次重试`);
        updateRetryCount(currentRetry);
        if (currentRetry >= maxRetries) {
          updateStatus(`❌ 题目 ${getCurrentProblemIndex()} 重试用尽，跳过`);
          currentProblemId = null;
          currentRetry = 0;
          code = null;
          problem = null;
          showUnACProblems();
          continue;
        }
        updateStatus('🤖 AI 修复代码中...');
        clearCodeDisplay();
        const aiResult = await requestAIStream('debug', { code, problem, testResult, errorType: 'wrong_answer' });
        if (aiResult.error) throw new Error(aiResult.error);
        code = aiResult.code;
        checkCancelled();
        apiRetry = 0;
        continue;
      }

      if (hintMode) {
        updateStatus('💡 提示模式：测试通过！建议检查后手动提交');
        showACAnimation();
        isRunning = false;
        break;
      }

      updateStatus('✅ 测试通过，提交中...');
      const submitResult = await submitAndWaitResult();
      checkCancelled();

      if (submitResult.error) {
        updateStatus(`⚠️ 提交异常: ${submitResult.error}`);
        sessionStorage.removeItem('pta-auto-solve');
        isRunning = false;
        break;
      }

      if (submitResult.passed) {
        updateStatus(`🎉 AC! 得分 ${submitResult.score?.earned}/${submitResult.score?.total}`);
        showACAnimation();
        currentRetry = 0;
        apiRetry = 0;
        code = null;
        problem = null;
        currentProblemId = null;
        showUnACProblems();

        await sleep(1000);
        checkCancelled();
      } else {
        currentRetry++;
        const reason = submitResult.status || '提交未通过';
        updateStatus(`🔧 ${reason}，第 ${currentRetry}/${maxRetries} 次重试`);
        updateRetryCount(currentRetry);

        if (currentRetry >= maxRetries) {
          updateStatus(`❌ 题目 ${getCurrentProblemIndex()} 重试用尽，跳过`);
          currentProblemId = null;
          currentRetry = 0;
          code = null;
          problem = null;
          showUnACProblems();
          continue;
        }

        updateStatus('🤖 AI 修复代码中...');
        clearCodeDisplay();
        const aiResult = await requestAIStream('debug', { code, problem, submitResult, errorType: 'submit_failed' });
        if (aiResult.error) throw new Error(aiResult.error);
        code = aiResult.code;
        checkCancelled();
        apiRetry = 0;
        continue;
      }
    } catch (err) {
      if (err.message === '任务已停止') {
        updateStatus('⏹ 已停止');
        sessionStorage.removeItem('pta-auto-solve');
        isRunning = false;
        break;
      }
      const isTransient = err.message.includes('504') || err.message.includes('502') || err.message.includes('503') || err.message.includes('timeout') || err.message.includes('超时');
      if (isTransient) {
        apiRetry++;
        if (apiRetry <= maxApiRetries) {
          updateStatus(`⚠️ API ${err.message.includes('504') ? '504' : '临时错误'}，第 ${apiRetry}/${maxApiRetries} 次重试，等待 5 秒...`);
          await sleep(5000);
          continue;
        } else {
          updateStatus(`❌ API 连续 ${maxApiRetries} 次失败，停止`);
          sessionStorage.removeItem('pta-auto-solve');
          isRunning = false;
        }
      }
      updateStatus(`⚠️ 错误: ${err.message}`);
      console.error('[PTA Auto Solver]', err);
      sessionStorage.removeItem('pta-auto-solve');
      isRunning = false;
    }
  }
}

// ============================================================
// Hint Mode Logic
// ============================================================
async function runHintMode() {
  const config = await chrome.storage.sync.get(['maxRetries', 'stepDelay']);
  maxRetries = parseInt(config.maxRetries) || 5;
  stepDelay = parseInt(config.stepDelay) || 1000;

  isRunning = true;
  hintMode = true;

  try {
    const existingCode = await getCode();
    let code = null;
    let problem = null;

    updateStatus('📖 读取题目...');
    problem = extractProblem();
    if (!problem) {
      updateStatus('⚠️ 未找到题目内容');
      isRunning = false;
      return;
    }
    updateProblemInfo(getCurrentProblemIndex());

    if (!existingCode) {
      updateStatus('🤖 AI 生成代码中...');
      clearCodeDisplay();
      const aiResult = await requestAIStream('generate', { problem });
      if (aiResult.error) throw new Error(aiResult.error);
      code = aiResult.code;

      updateStatus('📝 写入代码...');
      await setCode(code);
      await sleep(stepDelay);
    } else {
      code = existingCode;
      updateStatus('📋 检测到已有代码，直接测试');
    }

    updateStatus('🔍 检查编译输出...');
    const compiler = checkCompilerOutput();
    if (compiler.hasError) {
      updateStatus(`🔧 编译错误: ${compiler.output}`);
      updateStatus('🤖 AI 分析错误点和建议...');
      clearCodeDisplay();
      const aiResult = await requestHintStream({ code, problem, error: compiler.output, errorType: 'compile' });
      if (aiResult.error) throw new Error(aiResult.error);
      updateStatus(`💡 错误分析完成，请查看代码面板`);
      isRunning = false;
      return;
    }

    updateStatus('🧪 运行测试...');
    const testResult = await waitForTestResult();

    if (testResult.error) {
      updateStatus(`⚠️ 测试异常: ${testResult.error}`);
      isRunning = false;
      return;
    }

    if (!testResult.match) {
      updateStatus(`❌ 测试不匹配`);
      updateStatus(`📤 实际输出: ${testResult.actual}`);
      updateStatus(`📥 预期输出: ${testResult.expected}`);
      updateStatus('🤖 AI 分析错误点和建议...');
      clearCodeDisplay();
      const aiResult = await requestHintStream({ code, problem, testResult, errorType: 'wrong_answer' });
      if (aiResult.error) throw new Error(aiResult.error);
      updateStatus(`💡 错误分析完成，请查看代码面板`);
      isRunning = false;
      return;
    }

    updateStatus('🎉 测试通过！代码正确');
    showACAnimation();
    isRunning = false;
  } catch (err) {
    updateStatus(`⚠️ 错误: ${err.message}`);
    isRunning = false;
  }
}

// ============================================================
// UI Control Panel
// ============================================================
function injectPanel() {
  if (document.getElementById('pta-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'pta-panel';
  panel.innerHTML = `
    <style>
      @keyframes pta-glow-pulse {
        0%, 100% { filter: drop-shadow(0 0 4px rgba(0,245,255,0.4)); }
        50% { filter: drop-shadow(0 0 8px rgba(124,58,237,0.6)); }
      }
      @keyframes pta-fade-in {
        from { opacity: 0; transform: translateY(-10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      #pta-panel {
        position: fixed; top: 10px; right: 10px; z-index: 99999;
        background: linear-gradient(135deg, #0f0c29 0%, #1a1a2e 50%, #16213e 100%);
        color: #e0e0e0; padding: 16px;
        border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.5), 0 0 1px rgba(0,245,255,0.3);
        font-family: 'SF Mono', 'Consolas', monospace; font-size: 13px;
        width: 380px; border: 1px solid rgba(124,58,237,0.2);
        animation: pta-fade-in 0.3s ease-out;
        min-width: 280px; min-height: 300px; max-width: 800px; max-height: 90vh;
        overflow: auto;
      }
      #pta-panel.minimized {
        width: 170px !important; height: auto !important; min-width: 170px !important; min-height: auto !important;
        padding: 8px; border-radius: 16px;
      }
      #pta-panel.minimized > *:not(.logo-bar):not(.expand-wrap) { display: none !important; }
      #pta-panel.minimized .expand-wrap { display: block !important; }
      #pta-panel.minimized .logo-bar { margin-bottom: 4px; }
      .expand-wrap { display: none; margin-top: 6px; }
      .expand-wrap button { width: 100%; display: block; flex: none !important; padding: 8px 4px; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 12px; color: #fff; background: linear-gradient(135deg, #6b7280, #4b5563); transition: all 0.2s; }
      .expand-wrap button:hover { opacity: 0.85; transform: translateY(-1px); }
      #pta-panel .logo-bar {
        display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
      }
      #pta-panel .logo-bar svg {
        width: 90px; height: 27px; animation: pta-glow-pulse 3s ease-in-out infinite;
      }
      #pta-panel .version-badge {
        font-size: 9px; background: linear-gradient(135deg, #7c3aed, #f472b6);
        color: #fff; padding: 2px 6px; border-radius: 8px; font-weight: 600;
        letter-spacing: 0.5px;
      }
      #pta-panel .title {
        font-size: 14px; font-weight: bold; margin-bottom: 8px;
        display: flex; align-items: center; gap: 6px;
        cursor: grab; padding: 4px 0; color: #c084fc;
        user-select: none; -webkit-user-select: none;
      }
      #pta-panel .title:active { cursor: grabbing; }
      #pta-panel .title .drag-hint { font-size: 10px; color: #555; margin-left: auto; }
      #pta-panel .status { color: #aaa; margin-bottom: 12px; min-height: 20px; padding: 6px 8px; background: rgba(22,33,62,0.8); border-radius: 4px; border-left: 3px solid #7c3aed; }
      #pta-panel .btn-row { display: flex; gap: 8px; margin-bottom: 8px; }
      #pta-panel .btn-row button { flex: 1; }
      #pta-panel .min-row { margin-bottom: 8px; }
      #pta-panel .min-row button { width: 100%; }
      #pta-panel button {
        padding: 8px 4px; border: none; border-radius: 6px;
        cursor: pointer; font-weight: bold; font-size: 12px; color: #fff;
        transition: all 0.2s;
      }
      #pta-panel button:hover { opacity: 0.85; transform: translateY(-1px); }
      #pta-panel button:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
      #pta-panel .btn-start { background: linear-gradient(135deg, #10b981, #059669); }
      #pta-panel .btn-stop { background: linear-gradient(135deg, #ef4444, #dc2626); }
      #pta-panel .btn-hint { background: linear-gradient(135deg, #f59e0b, #d97706); }
      #pta-panel .btn-next { background: linear-gradient(135deg, #3b82f6, #2563eb); }
      #pta-panel .btn-minimize { background: linear-gradient(135deg, #6b7280, #4b5563); }
      #pta-panel .info { font-size: 11px; color: #666; display: flex; justify-content: space-between; }
      #pta-panel .mode-badge {
        display: inline-block; padding: 2px 8px; border-radius: 4px;
        font-size: 10px; font-weight: 600; margin-left: 8px;
      }
      #pta-panel .mode-badge.auto { background: #10b981; color: #fff; }
      #pta-panel .mode-badge.hint { background: #f59e0b; color: #fff; }
      #pta-panel .code-display { margin-top: 8px; max-height: 400px; overflow-y: auto; background: #0d1117; border-radius: 6px; padding: 14px; font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; color: #e6edf3; border: 1px solid #30363d; }
      #pta-panel .code-display::-webkit-scrollbar { width: 4px; }
      #pta-panel .code-display::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
      #pta-panel .code-header { font-size: 11px; color: #8b949e; margin-top: 8px; margin-bottom: 2px; display: flex; justify-content: space-between; align-items: center; }
      #pta-panel .code-header .copy-btn { cursor: pointer; color: #58a6ff; font-size: 10px; }
      #pta-panel .code-header .copy-btn:hover { text-decoration: underline; }
      #pta-panel .log { margin-top: 8px; max-height: 200px; overflow-y: auto; background: #0d1117; border-radius: 6px; padding: 10px; font-size: 12px; line-height: 1.6; }
      #pta-panel .log::-webkit-scrollbar { width: 4px; }
      #pta-panel .log::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
      #pta-panel .log .log-entry { color: #8b949e; white-space: pre-wrap; word-break: break-all; }
      #pta-panel .log .log-entry.log-warn { color: #d29922; }
      #pta-panel .log .log-entry.log-error { color: #f85149; }
      #pta-panel .log .log-entry.log-success { color: #3fb950; }
      #pta-panel .log .log-entry .log-time { color: #484f58; margin-right: 4px; }
      #pta-panel .stream-cursor {
        display: inline-block; width: 6px; height: 14px; background: #58a6ff;
        animation: blink 1s step-end infinite; vertical-align: middle;
      }
      @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
      #pta-panel .resize-handle {
        position: absolute; bottom: 0; right: 0; width: 16px; height: 16px;
        cursor: nwse-resize; z-index: 10;
      }
      #pta-panel .resize-handle::before, #pta-panel .resize-handle::after {
        content: ''; position: absolute; background: rgba(124,58,237,0.5); border-radius: 1px;
      }
      #pta-panel .resize-handle::before { width: 10px; height: 2px; bottom: 3px; right: 3px; }
      #pta-panel .resize-handle::after { width: 2px; height: 10px; bottom: 3px; right: 3px; }
      #pta-panel.minimized .resize-handle { display: none; }
    </style>
    <div class="logo-bar">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60">
        <defs>
          <linearGradient id="fx-g" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#00f5ff"/>
            <stop offset="50%" style="stop-color:#7c3aed"/>
            <stop offset="100%" style="stop-color:#f472b6"/>
          </linearGradient>
        </defs>
        <path d="M8 12 L28 12 L28 18 L14 18 L14 26 L26 26 L26 32 L14 32 L14 48 L8 48 Z" fill="url(#fx-g)"/>
        <path d="M32 12 L38 12 L38 42 L44 42 L44 48 L32 48 Z" fill="url(#fx-g)"/>
        <circle cx="52" cy="30" r="16" fill="none" stroke="url(#fx-g)" stroke-width="2"/>
        <path d="M46 30 L52 24 L58 30 L52 36 Z" fill="url(#fx-g)"/>
        <text x="72" y="38" font-family="'PingFang SC','Microsoft YaHei',sans-serif" font-size="22" font-weight="700" fill="url(#fx-g)">枫璇科技</text>
      </svg>
      <span class="version-badge">v3.0</span>
    </div>
    <div class="title" id="pta-title">
      🤖 PTA Auto Solver
      <span class="mode-badge auto" id="pta-mode-badge">自动</span>
      <span class="drag-hint">↕ 拖动</span>
    </div>
    <div class="status" id="pta-status">就绪</div>
    <div class="btn-row">
      <button class="btn-start" id="pta-start">▶ 自动</button>
      <button class="btn-hint" id="pta-hint">💡 提示</button>
      <button class="btn-stop" id="pta-stop">⏹ 停止</button>
      <button class="btn-next" id="pta-next">⏭</button>
    </div>
    <div class="min-row"><button class="btn-minimize" id="pta-minimize">收起 ▾</button></div>
    <div class="expand-wrap"><button class="btn-expand" id="pta-expand">+ 展开</button></div>
    <div class="info">
      <span>重试: <span id="pta-retry">0</span>/<span id="pta-maxRetry">5</span></span>
      <span>题目: <span id="pta-problem">-</span></span>
    </div>
    <div class="info" style="margin-top:4px;">
      <span>未通过: <span id="pta-unac" style="color:#f85149;">-</span></span>
    </div>
    <div class="code-header">
      <span>📝 AI 输出</span>
      <span class="copy-btn" id="pta-copy-code">复制</span>
    </div>
    <div class="code-display" id="pta-code-display">等待生成...</div>
    <div class="log" id="pta-log"></div>
    <div class="resize-handle" id="pta-resize"></div>
  `;
  document.body.appendChild(panel);

  let isDragging = false, startX, startY, origX, origY, dragStartTime = 0;
  const titleBar = document.getElementById('pta-title');
  const logoBar = panel.querySelector('.logo-bar');

  logoBar.addEventListener('dblclick', () => {
    if (panel.classList.contains('minimized')) {
      panel.classList.remove('minimized');
    }
  });

  titleBar.addEventListener('mousedown', (e) => {
    dragStartTime = Date.now();
    e.preventDefault();
    isDragging = true;
    const rect = panel.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    origX = rect.left;
    origY = rect.top;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = origX + 'px';
    panel.style.top = origY + 'px';
    panel.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    e.preventDefault();
    panel.style.left = (origX + e.clientX - startX) + 'px';
    panel.style.top = (origY + e.clientY - startY) + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    panel.style.cursor = '';
  });

  // Resize logic
  let isResizing = false, resizeStartX, resizeStartY, resizeStartW, resizeStartH;
  const resizeHandle = document.getElementById('pta-resize');

  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartW = panel.offsetWidth;
    resizeStartH = panel.offsetHeight;
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    e.preventDefault();
    const newW = Math.max(280, resizeStartW + e.clientX - resizeStartX);
    const newH = Math.max(300, resizeStartH + e.clientY - resizeStartY);
    panel.style.width = newW + 'px';
    panel.style.height = newH + 'px';
  });

  document.addEventListener('mouseup', () => {
    isResizing = false;
    isDragging = false;
  });

  document.getElementById('pta-start').onclick = async () => {
    hintMode = false;
    updateModeBadge('auto');
    document.getElementById('pta-start').disabled = true;
    await autoSolve();
    document.getElementById('pta-start').disabled = false;
  };

  document.getElementById('pta-hint').onclick = async () => {
    hintMode = true;
    updateModeBadge('hint');
    document.getElementById('pta-hint').disabled = true;
    await runHintMode();
    document.getElementById('pta-hint').disabled = false;
  };

  document.getElementById('pta-stop').onclick = () => {
    isRunning = false;
    hintMode = false;
    sessionStorage.removeItem('pta-auto-solve');
    updateStatus('⏹ 已停止');
  };

  document.getElementById('pta-next').onclick = () => {
    const next = findNextUnACProblem();
    if (next) goToProblem(next.problemId);
  };

  document.getElementById('pta-minimize').onclick = () => {
    panel.classList.add('minimized');
    document.getElementById('pta-minimize').textContent = '−';
  };

  document.getElementById('pta-expand').onclick = () => {
    panel.classList.remove('minimized');
    document.getElementById('pta-minimize').textContent = '−';
  };

  document.getElementById('pta-copy-code').onclick = () => {
    const code = document.getElementById('pta-code-display').textContent;
    if (code && code !== '等待生成...') {
      navigator.clipboard.writeText(code).then(() => {
        document.getElementById('pta-copy-code').textContent = '已复制✓';
        setTimeout(() => { document.getElementById('pta-copy-code').textContent = '复制'; }, 1500);
      });
    }
  };
}

function updateModeBadge(mode) {
  const badge = document.getElementById('pta-mode-badge');
  if (!badge) return;
  if (mode === 'hint') {
    badge.textContent = '提示';
    badge.className = 'mode-badge hint';
  } else {
    badge.textContent = '自动';
    badge.className = 'mode-badge auto';
  }
}

function clearCodeDisplay() {
  const el = document.getElementById('pta-code-display');
  if (el) {
    el.textContent = '';
    el.innerHTML = '<span class="stream-cursor"></span>';
  }
}

function appendCodeStream(chunk) {
  const el = document.getElementById('pta-code-display');
  if (!el) return;
  const cursor = el.querySelector('.stream-cursor');
  const textNode = document.createTextNode(chunk);
  if (cursor) {
    el.insertBefore(textNode, cursor);
  } else {
    el.appendChild(textNode);
  }
  el.scrollTop = el.scrollHeight;
}

function showCode(code) {
  const el = document.getElementById('pta-code-display');
  if (el) el.textContent = code || '';
}

function appendLog(text, isError) {
  const log = document.getElementById('pta-log');
  if (!log) return;
  const entry = document.createElement('div');
  entry.className = 'log-entry' + (isError ? ' log-error' : '');
  const time = new Date().toLocaleTimeString();
  entry.innerHTML = `<span class="log-time">[${time}]</span>${text}`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function updateStatus(text) {
  const el = document.getElementById('pta-status');
  if (el) el.textContent = text;
  appendLog(text);
}

function updateRetryCount(count) {
  const el = document.getElementById('pta-retry');
  if (el) el.textContent = count;
}

function updateProblemInfo(index) {
  const el = document.getElementById('pta-problem');
  if (el) el.textContent = index || '-';

  chrome.storage.sync.get(['maxRetries'], (v) => {
    const maxEl = document.getElementById('pta-maxRetry');
    if (maxEl) maxEl.textContent = v.maxRetries || '5';
  });
}

// ============================================================
// Initialize
// ============================================================
function init() {
  injectPanel();
  showUnACProblems();
  if (sessionStorage.getItem('pta-auto-solve') === 'running') {
    updateStatus('🔄 页面跳转，自动恢复运行...');
    setTimeout(() => autoSolve(), 2000);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
