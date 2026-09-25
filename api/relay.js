export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;

  if (!DEEPSEEK_KEY) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ error: 'API key not configured' });
  }

  const BASE_URL = 'https://api.deepseek.com/chat/completions';
  const TEXT_MODEL = 'deepseek-flash';
  const VISION_MODEL = 'deepseek-v4.1-flash';

  // Универсальный запрос к DeepSeek
  async function ask(msgs, model) {
    try {
      const r = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + DEEPSEEK_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model, messages: msgs, max_tokens: 200, temperature: 0.85, stream: false })
      });
      if (!r.ok) {
        const t = await r.text();
        console.error('DeepSeek error:', r.status, t);
        return { ok: false, err: r.status + ' ' + t.slice(0, 300) };
      }
      const d = await r.json();
      const c = d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : null;
      if (!c) {
        console.error('DeepSeek empty:', JSON.stringify(d).slice(0, 300));
        return { ok: false, err: 'пустой ответ: ' + JSON.stringify(d).slice(0, 200) };
      }
      return { ok: true, reply: c };
    } catch (e) {
      console.error('DeepSeek fetch error:', e);
      return { ok: false, err: String(e).slice(0, 200) };
    }
  }

  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const parsedBody = JSON.parse(body);
    const { text, image, systemPrompt, history, lastThought, events, userStatus, checkInitiative } = parsedBody;

    // === ИНИЦИАТИВА ===
    if (checkInitiative) {
      const st = parsedBody.state || {};
      const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Krasnoyarsk' });
      const sinceLastUser = st.lastUserMessageTime ? Math.round((Date.now() - st.lastUserMessageTime) / 60000) : 999;
      const lastMsg = (st.messages || []).slice(-1)[0];
      const prompt = `Ты Маша, 17 лет, Красноярск. Сейчас: ${now}. Твоё состояние: ${st.currentState || 'calm'}. Он не писал: ${sinceLastUser} мин. Он сейчас: ${st.userStatus || 'awake'}. Последнее обсуждали: ${(lastMsg && lastMsg.content || 'ничего').slice(0, 100)}.
Хочешь написать ему прямо сейчас? Если да — 1 короткое предложение в твоём стиле (lowercase, без эмодзи). Если нет — почему.
Формат ТОЛЬКО: "ХОЧУ: <текст>" или "НЕ ХОЧУ: <причина>".`;
      const out = await ask([{ role: 'user', content: prompt }], TEXT_MODEL);
      let result = { initiative: false, reason: 'не знаю' };
      if (out.ok) {
        const r = out.reply;
        if (r.startsWith('ХОЧУ:')) result = { initiative: true, text: r.replace('ХОЧУ:', '').trim() };
        else if (r.startsWith('НЕ ХОЧУ:')) result = { initiative: false, reason: r.replace('НЕ ХОЧУ:', '').trim() };
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json(result);
    }

    // === ВНУТРЕННИЙ МОНОЛОГ ===
    let thought = '';
    if (text || image) {
      const hist = (history || []).slice(-5).map(m => (m.role === 'user' ? 'Он: ' : 'Ты: ') + m.content).join('\n');
      const tp = `Ты Маша. Контекст:\n${hist}\nПользователь написал: ${text || '[фото]'}\nТвоя прошлая мысль: ${lastThought || 'ничего'}\nНапиши ОДНУ мысль до 15 слов про себя, lowercase, не для пользователя.`;
      const out = await ask([{ role: 'user', content: tp }], TEXT_MODEL);
      if (out.ok) thought = out.reply.slice(0, 120);
    }

    // === САНИТАЦИЯ ИСТОРИИ (главная починка) ===
    const clean = [];
    for (const m of (history || [])) {
      if (!m || typeof m.content !== 'string' || !m.content.trim()) continue;
      let role = m.role === 'bot' ? 'assistant' : m.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const prev = clean[clean.length - 1];
      if (prev && prev.role === role) prev.content += '\n' + m.content; // склеиваем подряд идущие одинаковые
      else clean.push({ role: role, content: m.content });
    }
    while (clean.length && clean[clean.length - 1].role === 'user') clean.pop(); // не должно заканчиваться на user

    let userContent;
    if (image) {
      userContent = [
        { type: 'text', text: text || 'Отреагируй на это фото.' },
        { type: 'image_url', image_url: { url: image } }
      ];
    } else {
      userContent = text || '';
    }

    const systemMsg = { role: 'system', content: (systemPrompt || '') + '\n\nТы сейчас думаешь: ' + (thought || 'ничего особого') };
    const fullMessages = [systemMsg].concat(clean.slice(-15), [{ role: 'user', content: userContent }]);

    // === ЗАПРОС: сначала с историей, при неудаче — без истории ===
    let out = await ask(fullMessages, image ? VISION_MODEL : TEXT_MODEL);
    if (!out.ok) {
      console.error('Retry without history. Reason:', out.err);
      out = await ask([systemMsg, { role: 'user', content: userContent }], image ? VISION_MODEL : TEXT_MODEL);
    }
    if (!out.ok) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json({ reply: '【ошибка: ' + out.err + '】', thought: thought });
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({ reply: out.reply, thought: thought });

  } catch (e) {
    console.error('API Error:', e);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({ reply: '【ошибка сервера: ' + String(e).slice(0, 200) + '】', thought: '' });
  }
}
