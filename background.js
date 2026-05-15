function buildHeaders(apiKey, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return headers;
}

function deriveModelsUrl(baseUrl) {
  if (baseUrl.endsWith('/messages')) return baseUrl.replace(/\/messages$/, '/models');
  if (baseUrl.endsWith('/chat/completions')) return baseUrl.replace(/\/chat\/completions$/, '/models');
  if (/\/v1\/?$/.test(baseUrl)) return baseUrl.replace(/\/v1\/?$/, '/v1/models');
  return baseUrl + '/models';
}

function resolveChatUrl(baseUrl, providerName) {
  const needsChat = !baseUrl.endsWith('/chat/completions') && !baseUrl.endsWith('/messages');
  if (!needsChat) return baseUrl;
  const path = providerName === 'anthropic' ? '/messages' : '/chat/completions';
  return baseUrl.replace(/\/+$/, '') + path;
}

const AI_PROVIDERS = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1/messages',
    modelsUrl: 'https://api.anthropic.com/v1/models',
    headers: (apiKey) => {
      const h = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
      if (apiKey) h['x-api-key'] = apiKey;
      return h;
    },
    body: (model, prompt) => ({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
    extract: (data) => data.content[0].text,
    extractStream: (data) => data.delta?.text || '',
    extractModels: (data) => (data.data || []).filter(m => m.id).map(m => ({
      id: m.id,
      name: m.display_name || m.id,
    })),
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    modelsUrl: 'https://api.openai.com/v1/models',
    headers: (apiKey) => buildHeaders(apiKey),
    body: (model, prompt) => ({
      model: model || 'gpt-4o',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
    extract: (data) => data.choices[0].message.content,
    extractStream: (data) => data.choices?.[0]?.delta?.content || '',
    extractModels: (data, isCustom) => {
      let models = data.data || [];
      if (!isCustom) models = models.filter(m => m.id && m.id.startsWith('gpt-'));
      return models
        .filter(m => m.id)
        .sort((a, b) => b.id.localeCompare(a.id))
        .map(m => ({ id: m.id, name: m.id }));
    },
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'runInPage') {
    if (!sender.tab?.id) {
      sendResponse({ error: 'no tab id' });
      return false;
    }
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: (code) => {
        try {
          return { result: new Function(code)() };
        } catch (e) {
          return { error: e.message };
        }
      },
      args: [msg.code],
    }).then(([result]) => sendResponse(result.result))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'generate' || msg.type === 'debug') {
    handleAI(msg.type, msg.data)
      .then(sendResponse)
      .catch(e => {
        const errMsg = e.name === 'AbortError' ? 'AI 请求超时(30s)' : e.message;
        sendResponse({ error: errMsg });
      });
    return true;
  }
  if (msg.type === 'generateStream' || msg.type === 'debugStream') {
    handleAIStream(msg.type, msg.data, sender)
      .catch(e => {
        chrome.tabs.sendMessage(sender.tab.id, { type: 'streamError', error: e.message });
      });
    return true;
  }
  if (msg.type === 'hintStream') {
    handleAIStream('hint', msg.data, sender)
      .catch(e => {
        chrome.tabs.sendMessage(sender.tab.id, { type: 'streamError', error: e.message });
      });
    return true;
  }
  if (msg.type === 'listModels') {
    listModels(msg.data)
      .then(sendResponse)
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }
});

async function handleAI(type, data) {
  const config = await chrome.storage.sync.get([
    'apiKey', 'model', 'provider', 'aiBaseUrl',
  ]);

  const providerName = config.provider || 'openai';
  const provider = AI_PROVIDERS[providerName];

  if (!provider) {
    throw new Error(`不支持的 AI 提供商: ${providerName}`);
  }

  const prompt = type === 'generate'
    ? buildGeneratePrompt(data)
    : buildDebugPrompt(data);

  const rawUrl = config.aiBaseUrl || (providerName === 'openai' ? 'https://newapi.doclaw.cn/v1' : provider.baseUrl);
  const baseUrl = resolveChatUrl(rawUrl, providerName);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  const resp = await fetch(baseUrl, {
    method: 'POST',
    headers: provider.headers(config.apiKey),
    body: JSON.stringify(provider.body(config.model, prompt)),
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`AI API 错误 (${resp.status}): ${err}`);
  }

  const result = await resp.json();
  const text = provider.extract(result);
  const code = extractCode(text);

  return { code };
}

async function handleAIStream(type, data, sender) {
  const config = await chrome.storage.sync.get([
    'apiKey', 'model', 'provider', 'aiBaseUrl',
  ]);

  const providerName = config.provider || 'openai';
  const provider = AI_PROVIDERS[providerName];

  if (!provider) {
    throw new Error(`不支持的 AI 提供商: ${providerName}`);
  }

  const prompt = type === 'generateStream'
    ? buildGeneratePrompt(data)
    : type === 'hint'
    ? buildHintPrompt(data)
    : buildDebugPrompt(data);

  const rawUrl = config.aiBaseUrl || (providerName === 'openai' ? 'https://newapi.doclaw.cn/v1' : provider.baseUrl);
  const baseUrl = resolveChatUrl(rawUrl, providerName);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  const body = provider.body(config.model, prompt);
  body.stream = true;

  const resp = await fetch(baseUrl, {
    method: 'POST',
    headers: provider.headers(config.apiKey),
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (!resp.ok) {
    const err = await resp.text();
    chrome.tabs.sendMessage(sender.tab.id, { type: 'streamError', error: `AI API 错误 (${resp.status}): ${err}` });
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const delta = provider.extractStream(parsed);
            if (delta) {
              fullText += delta;
              chrome.tabs.sendMessage(sender.tab.id, { type: 'streamChunk', chunk: delta, fullText });
            }
          } catch (e) {}
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      chrome.tabs.sendMessage(sender.tab.id, { type: 'streamError', error: e.message });
      return;
    }
  }

  const code = extractCode(fullText);
  chrome.tabs.sendMessage(sender.tab.id, { type: 'streamComplete', code, fullText });
}

async function listModels({ provider, apiKey, baseUrl }) {
  const prov = AI_PROVIDERS[provider];
  if (!prov) throw new Error(`不支持的提供商: ${provider}`);

  const effectiveUrl = baseUrl || (provider === 'openai' ? 'https://newapi.doclaw.cn/v1' : null);
  const url = effectiveUrl ? deriveModelsUrl(effectiveUrl) : prov.modelsUrl;

  let resp;
  try {
    resp = await fetch(url, {
      headers: prov.headers(apiKey),
    });
  } catch (e) {
    throw new Error(`无法连接到 ${new URL(url).hostname}，请检查地址是否正确或服务是否可用`);
  }

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`获取模型列表失败 (${resp.status}): ${err.slice(0, 200)}`);
  }

  const result = await resp.json();
  if (!result.data || !Array.isArray(result.data)) {
    throw new Error(`响应格式异常，期望 models[]，实际: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return { models: prov.extractModels(result, !!baseUrl) };
}

function buildGeneratePrompt(data) {
  const p = data.problem;
  const isFunc = p.isFunctionProblem;
  const lang = p.language || 'C';

  const langSpecs = {
    'C (gcc)': { name: 'C', ext: 'c', funcMain: false },
    'C++ (g++)': { name: 'C++', ext: 'cpp', funcMain: false },
    'Python (python3)': { name: 'Python', ext: 'py', funcMain: false },
  };

  const spec = langSpecs[lang] || { name: 'C', ext: 'c' };

  let typeInstruction;
  if (isFunc) {
    typeInstruction = `【函数题】只需实现题目要求的函数，不要包含 main 函数和 #include。裁判程序会自动提供完整上下文。`;
  } else {
    typeInstruction = `【编程题】需要提供完整的可运行代码，包含必要的 #include 和 main 函数。`;
  }

  return `你是竞赛编程专家。根据以下 PTA 题目，用 ${spec.name} 语言编写解决方案。

${typeInstruction}

题目信息：
${JSON.stringify(p.sections, null, 2)}

分数: ${p.score}
时间限制: ${p.timeLimit}ms
内存限制: ${p.memLimit}MB
代码限制: ${p.codeLimit}KB

要求：
1. 严格遵循输入输出格式
2. 不要包含任何解释文字
3. 只输出代码，用 \`\`\`${spec.ext} 和 \`\`\` 包裹
4. 注意边界条件和特殊值处理
5. 使用高效算法满足时间限制
6. 代码中不要包含任何注释`;
}

function buildDebugPrompt(data) {
  const p = data.problem;
  const lang = p.language || 'C';
  const ext = lang === 'Python (python3)' ? 'py' : lang.toLowerCase().startsWith('c++') ? 'cpp' : 'c';

  const sections = [
    '=== 题目信息 ===',
    JSON.stringify(p.sections, null, 2),
    `分数: ${p.score}`,
    `时间限制: ${p.timeLimit}ms`,
    `内存限制: ${p.memLimit}MB`,
    `代码限制: ${p.codeLimit}KB`,
    '',
    '=== 之前的代码 ===',
    `\`\`\`${ext}`,
    data.code,
    '```',
  ];

  if (data.errorType === 'compile' && data.error) {
    sections.push('', '=== 编译错误 ===', data.error);
  }

  if (data.errorType === 'runtime' && data.testResult?.status) {
    sections.push('', '=== 运行时错误 ===', `状态: ${data.testResult.status}`);
  }

  if (data.errorType === 'wrong_answer' && data.testResult) {
    sections.push(
      '',
      '=== 自测不匹配 ===',
      `实际输出:\n${data.testResult.actual}`,
      '',
      `预期输出:\n${data.testResult.expected}`,
    );
  }

  if (data.errorType === 'test_error' && data.testResult?.error) {
    sections.push('', '=== 自测异常 ===', data.testResult.error);
  }

  if (data.errorType === 'submit_failed' && data.submitResult) {
    const lines = ['', `=== 提交结果: ${data.submitResult.status} ===`];
    if (data.submitResult.score) {
      lines.push(`得分: ${data.submitResult.score.earned}/${data.submitResult.score.total}`);
    }
    if (data.submitResult.time) lines.push(`用时: ${data.submitResult.time}`);
    if (data.submitResult.memory) lines.push(`内存: ${data.submitResult.memory}`);
    if (data.submitResult.testCases && data.submitResult.testCases.length > 0) {
      lines.push('评测详情:');
      data.submitResult.testCases.forEach(t => {
        lines.push(`  ${t.id}: ${t.result} (${t.score}) 内存:${t.memory} 时间:${t.time}`);
      });
    }
    sections.push(...lines);
  }

  sections.push(
    '',
    '=== 修复要求 ===',
    '1. 仔细分析上述错误信息',
    '2. 检查边界条件、数组越界、空指针、死循环等常见问题',
    '3. 如果超时，考虑优化算法复杂度',
    '4. 如果答案错误，仔细比对输出格式差异',
    '5. 输出修正后的完整代码',
    '6. 只输出代码，用 ``` 包裹',
    '7. 代码中不要包含任何注释',
  );

  return sections.join('\n');
}

function buildHintPrompt(data) {
  const p = data.problem;
  const lang = p.language || 'C';
  const ext = lang === 'Python (python3)' ? 'py' : lang.toLowerCase().startsWith('c++') ? 'cpp' : 'c';

  const sections = [
    '你是一位竞赛编程专家。请分析以下代码的错误点，并给出修复建议。',
    '',
    '=== 题目信息 ===',
    JSON.stringify(p.sections, null, 2),
    `分数: ${p.score}`,
    `时间限制: ${p.timeLimit}ms`,
    `内存限制: ${p.memLimit}MB`,
    `代码限制: ${p.codeLimit}KB`,
    '',
    '=== 当前代码 ===',
    `\`\`\`${ext}`,
    data.code,
    '```',
  ];

  if (data.errorType === 'compile' && data.error) {
    sections.push('', '=== 编译错误 ===', data.error);
  }

  if (data.errorType === 'wrong_answer' && data.testResult) {
    sections.push(
      '',
      '=== 测试不匹配 ===',
      `实际输出:\n${data.testResult.actual}`,
      '',
      `预期输出:\n${data.testResult.expected}`,
    );
  }

  sections.push(
    '',
    '=== 分析要求 ===',
    '1. 指出代码中的具体错误点（行号或逻辑位置）',
    '2. 解释为什么会产生这个错误',
    '3. 给出修复建议（描述修改思路，不需要给出完整代码）',
    '4. 如果是算法问题，建议更优的算法思路',
    '5. 如果是边界条件问题，指出哪些测试用例可能失败',
    '6. 用清晰的中文回答，分点列出',
  );

  return sections.join('\n');
}

function extractCode(text) {
  const match = text.match(/```(?:\w+)?\n?([\s\S]*?)```/);
  return match ? match[1].trim() : text.trim();
}
