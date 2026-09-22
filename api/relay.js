export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;

  if (!DEEPSEEK_KEY) {
    console.error('DEEPSEEK_API_KEY not found');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ error: 'API key not configured' });
  }

  const BASE_URL = 'https://api.deepseek.com/chat/completions';
  const TEXT_MODEL = 'deepseek-flash';
  const VISION_MODEL = 'deepseek-v4.1-flash';

  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const parsedBody = JSON.parse(body);
    
    const { 
      text, 
      image, 
      systemPrompt, 
      history, 
      lastThought, 
      events, 
      userStatus,
      checkInitiative,
      getSurprise
    } = parsedBody;

    // === ЭНДПОИНТ: СУРПРИЗ (поиск популярного) ===
    if (getSurprise) {
      const surpriseType = parsedBody.surpriseType || 'meme';
      
      // Ищем популярный контент по её интересам
      const searchPrompts = {
        meme: 'Найди популярный мем 2024-2025 года про отношения, котов, учёбу или повседневную жизнь. Опиши его: что на картинке, какой текст (если есть), в чём прикол.',
        song: 'Назови 3 самые популярные песни 2024-2025 года, которые могут понравиться 17-летней девушке (поп, инди, альтернатива). Укажи название и исполнителя.',
        anime: 'Посоветуй популярное аниме 2024-2025 года, которое стоит посмотреть. Краткое описание: жанр, о чём, почему стоит смотреть.',
        video: 'Найди популярное смешное видео или тренд TikTok 2024-2025. Опиши: что происходит, почему смешно.'
      };
      
      const surpriseRes = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + DEEPSEEK_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: TEXT_MODEL,
          messages: [
            { 
              role: 'system', 
              content: 'Ты Маша, 17 лет. Ты ищешь что-то интересное, чтобы поделиться с Эдуардом. Будь краткой и живой.'
            },
            { 
              role: 'user', 
              content: `Найди что-то популярное и классное (${surpriseType}). ${searchPrompts[surpriseType] || searchPrompts.meme}`
            }
          ],
          max_tokens: 200,
          temperature: 0.8
        })
      });

      if (!surpriseRes.ok) {
        console.error('Surprise error:', surpriseRes.status, await surpriseRes.text());
        return res.status(500).json({ error: 'Failed to get surprise' });
      }

      const surpriseData = await surpriseRes.json();
      const content = surpriseData.choices?.[0]?.message?.content || 'Ничего не нашла';
      
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json({ surprise: content, type: surpriseType });
    }

    // === ЭНДПОИНТ: ИНИЦИАТИВА ===
    if (checkInitiative) {
      const { state } = parsedBody;
      const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Krasnoyarsk' });
      const sinceLastUser = state?.lastUserMessageTime 
        ? Math.round((Date.now() - state.lastUserMessageTime) / (1000 * 60)) 
        : 999;
      
      const lastMsg = state?.messages?.slice(-1)[0];
      const lastMsgTopic = lastMsg?.content?.slice(0, 100) || 'ничего';
      
      const initiativePrompt = `Ты Маша, 17 лет, Красноярск. Встречаешься с Эдуардом 2 года.
Сейчас: ${now}
Твоё состояние: ${state?.currentState || 'calm'}
Твои последние события: ${state?.events?.slice(-2).map(e => e.text).join(', ') || 'ничего особенного'}
Ты последний раз думала: ${state?.lastThought || 'ничего особого'}
Он не писал: ${sinceLastUser} мин
Он сейчас: ${state?.userStatus || 'awake'}
Последнее, что вы обсуждали: ${lastMsgTopic}

Хочешь написать ему прямо сейчас? Если да — что именно (1 короткое предложение, в твоём стиле, lowercase, без эмодзи). Если нет — почему.
Формат ответа ТОЛЬКО: "ХОЧУ: <текст>" или "НЕ ХОЧУ: <причина>".`;

      const initiativeRes = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + DEEPSEEK_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: TEXT_MODEL,
          messages: [{ role: 'user', content: initiativePrompt }],
          max_tokens: 50,
          temperature: 0.9
        })
      });

      if (!initiativeRes.ok) {
        console.error('Initiative error:', initiativeRes.status, await initiativeRes.text());
        return res.status(500).json({ error: 'Initiative failed' });
      }

      const initiativeData = await initiativeRes.json();
      const response = initiativeData.choices?.[0]?.message?.content || 'НЕ ХОЧУ: не знаю';
      
      let result;
      if (response.startsWith('ХОЧУ:')) {
        result = { initiative: true, text: response.replace('ХОЧУ:', '').trim() };
      } else if (response.startsWith('НЕ ХОЧУ:')) {
        result = { initiative: false, reason: response.replace('НЕ ХОЧУ:', '').trim() };
      } else {
        result = { initiative: false, reason: response };
      }
      
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json(result);
    }

    // === ШАГ 1: ВНУТРЕННИЙ МОНОЛОГ (скрытый) ===
    let thought = '';
    if (text || image) {
      const recentHistory = history?.slice(-5) || [];
      const historyText = recentHistory.map(m => `${m.role === 'user' ? 'Он' : 'Ты'}: ${m.content}`).join('\n');
      
      const thoughtPrompt = `Ты Маша. Вот контекст:
${historyText}

Пользователь написал: ${text || '[отправил фото]'}
Твоё состояние: ${events?.slice(-1).map(e => e.text).join(', ') || 'обычное'}
Ты последний раз думала: ${lastThought || 'ничего'}

Напиши ОДНУ короткую мысль (максимум 15 слов), что ты сейчас думаешь про себя. Это твоя внутренняя реакция, не для показа пользователю. Пиши на русском, lowercase.`;

      try {
        const thoughtRes = await fetch(BASE_URL, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + DEEPSEEK_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: TEXT_MODEL,
            messages: [{ role: 'user', content: thoughtPrompt }],
            max_tokens: 30,
            temperature: 0.7
          })
        });

        if (thoughtRes.ok) {
          const thoughtData = await thoughtRes.json();
          thought = thoughtData.choices?.[0]?.message?.content || '';
        }
      } catch (e) {
        console.error('Thought error:', e);
      }
    }

    // === ШАГ 2: ОСНОВНОЙ ОТВЕТ ===
    let userContent;
    
    if (image) {
      userContent = [
        { type: "text", text: text || "Отреагируй на это фото." },
        { type: "image_url", image_url: { url: image } }
      ];
    } else {
      userContent = text || "";
    }

    // Формируем messages с историей
    const messages = [
      { 
        role: "system", 
        content: `${systemPrompt}\n\nТы сейчас думаешь: ${thought || 'ничего особого'}`
      },
      ...(history?.slice(-15) || []),
      { role: "user", content: userContent }
    ];

    const response = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + DEEPSEEK_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: image ? VISION_MODEL : TEXT_MODEL,
        messages: messages,
        max_tokens: 200,
        temperature: 0.85,
        stream: false
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('DeepSeek API error:', response.status, errorText);
      throw new Error(`DeepSeek API ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "Что-то пошло не так...";

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({ reply, thought });

  } catch (e) {
    console.error("API Error:", e);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: String(e) });
  }
}
