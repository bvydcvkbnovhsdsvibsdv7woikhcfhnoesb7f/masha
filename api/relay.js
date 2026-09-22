export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
  const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

  if (!DEEPSEEK_KEY) {
    console.error('DEEPSEEK_API_KEY not found');
    return res.status(500).json({ error: 'DeepSeek API key not configured' });
  }

  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const parsedBody = JSON.parse(body);
    
    const { text, image, systemPrompt } = parsedBody;
    let finalUserMessage = text || "";

    // ШАГ 1: Vision-модель (через OpenRouter, если есть фото)
    if (image && OPENROUTER_KEY) {
      try {
        const visionRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + OPENROUTER_KEY,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://masha-mf60.vercel.app',
            'X-Title': 'Masha Chat'
          },
          body: JSON.stringify({
            model: "meta-llama/llama-3.2-11b-vision-instruct",
            messages: [{
              role: "user",
              content: [
                { type: "text", text: "Кратко опиши, что на этом фото на русском (2-3 предложения)." },
                { type: "image_url", image_url: { url: image } }
              ]
            }],
            max_tokens: 200
          })
        });

        if (visionRes.ok) {
          const visionData = await visionRes.json();
          const description = visionData.choices?.[0]?.message?.content || "Не удалось разобрать фото";
          finalUserMessage = `[Пользователь отправил фото. Описание: ${description}] ${text || 'Отреагируй на фото.'}`;
        } else {
          const errText = await visionRes.text();
          console.error('Vision failed:', visionRes.status, errText);
          finalUserMessage = `[Пользователь отправил фото] ${text || 'Отреагируй на фото.'}`;
        }
      } catch (e) {
        console.error('Vision error:', e);
        finalUserMessage = `[Пользователь отправил фото] ${text || 'Отреагируй на фото.'}`;
      }
    }

    // ШАГ 2: Текстовая модель (DeepSeek)
    const mashaRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + DEEPSEEK_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "deepseek-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: finalUserMessage }
        ],
        temperature: 0.85,
        max_tokens: 150,
        stream: false
      })
    });

    if (!mashaRes.ok) {
      const errText = await mashaRes.text();
      throw new Error(`DeepSeek API ${mashaRes.status}: ${errText}`);
    }

    const mashaData = await mashaRes.json();
    const reply = mashaData.choices?.[0]?.message?.content || "Что-то пошло не так...";

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(JSON.stringify({ reply }));

  } catch (e) {
    console.error("API Error:", e);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(500).send(JSON.stringify({ error: String(e) }));
  }
}
