function getVal(id) {
  return document.getElementById(id).value;
}

function setVal(id, val) {
  if (val !== undefined && val !== null) {
    document.getElementById(id).value = val;
  }
}

function setModelStatus(text, isError) {
  const el = document.getElementById('modelStatus');
  el.textContent = text;
  el.style.color = isError ? '#f85149' : '#8b949e';
}

async function fetchModels() {
  const provider = getVal('provider');
  const apiKey = getVal('apiKey');
  const baseUrl = getVal('aiBaseUrl');

  if (!apiKey && !baseUrl) {
    setModelStatus('输入 API Key 或自定义地址后刷新', true);
    return;
  }

  const btn = document.getElementById('refreshModels');
  const select = document.getElementById('model');
  const savedModel = select.value || '';

  btn.disabled = true;
  btn.textContent = '⏳';
  setModelStatus('加载模型中...');

  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'listModels',
      data: { provider, apiKey, baseUrl },
    });

    if (resp?.error) throw new Error(resp.error);

    select.innerHTML = '<option value="">— 请选择模型 —</option>';
    for (const m of resp.models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      select.appendChild(opt);
    }

    if (savedModel) select.value = savedModel;
    setModelStatus(`共 ${resp.models.length} 个模型`);
  } catch (err) {
    setModelStatus(`加载失败: ${err.message} (可手动输入模型名)`, true);
    console.error('[PTA] fetchModels error:', err);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄';
  }
}

function loadSettings() {
  chrome.storage.sync.get(
    ['apiKey', 'model', 'provider', 'language', 'maxRetries', 'stepDelay', 'aiBaseUrl'],
    (v) => {
      setVal('provider', v.provider || 'openai');
      setVal('apiKey', v.apiKey);
      setVal('model', v.model);
      setVal('language', v.language);
      setVal('maxRetries', v.maxRetries);
      setVal('stepDelay', v.stepDelay);
      setVal('aiBaseUrl', v.aiBaseUrl || 'https://newapi.doclaw.cn/v1');

      if ((v.apiKey || v.aiBaseUrl) && v.provider) {
        fetchModels();
      }
    }
  );
}

document.addEventListener('DOMContentLoaded', loadSettings);

document.getElementById('refreshModels').onclick = fetchModels;

document.getElementById('provider').onchange = () => {
  document.getElementById('model').value = '';
  fetchModels();
};

document.getElementById('save').onclick = () => {
  chrome.storage.sync.set({
    provider: getVal('provider'),
    apiKey: getVal('apiKey'),
    model: getVal('model'),
    language: getVal('language'),
    maxRetries: getVal('maxRetries'),
    stepDelay: getVal('stepDelay'),
    aiBaseUrl: getVal('aiBaseUrl'),
  }, () => {
    const s = document.getElementById('saved');
    s.style.display = 'block';
    setTimeout(() => { s.style.display = 'none'; }, 2000);
  });
};
