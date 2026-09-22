export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  const API_KEY = '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';

  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const parsedBody = JSON.parse(body);
    
    const { text, image, systemPrompt } = parsedBody;
    let finalUserMessage = text || "";

    // ШАГ 1: Если есть фото, отправляем в Vision-модель
    if (image) {
      try {
        const visionRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + API_KEY,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://masha-mf60.vercel.app',
            'X-Title': 'Masha Chat'
          },
          body: JSON.stringify({
            model: "meta-llama/llama-3.2-11b-vision-instruct:free",
            messages: [{
              role: "user",
              content: [
                { type: "text", text: "Кратко опиши, что на этом фото: кто, что, где, эмоции, детали. Максимум 2-3 предложения. Пиши на русском." },
                { type: "image_url", image_url: { url: image } }
              ]
            }]
          })
        });

        if (visionRes.ok) {
          const visionData = await visionRes.json();
          const description = visionData.choices?.[0]?.message?.content || "Не удалось разобрать фото";
          finalUserMessage = `[Пользователь отправил фото. Описание изображения: ${description}] ${text ? 'Он также написал: ' + text : 'Отреагируй на это фото.'}`;
        } else {
          console.error('Vision error:', visionRes.status);
          finalUserMessage = `[Пользователь отправил фото] ${text || 'Отреагируй на это фото.'}`;
        }
      } catch (visionError) {
        console.error('Vision failed:', visionError);
        finalUserMessage = `[Пользователь отправил фото] ${text || 'Отреагируй на это фото.'}`;
      }
    }

    // ШАГ 2: Отправляем в основную модель Маши
    const mashaRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://masha-mf60.vercel.app',
        'X-Title': 'Masha Chat'
      },
      body: JSON.stringify({
        model: "meta-llama/llama-3.1-8b-instruct:free",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: finalUserMessage }
        ],
        temperature: 0.85,
        max_tokens: 150
      })
    });

    if (!mashaRes.ok) {
      const errorText = await mashaRes.text();
      throw new Error(`API ${mashaRes.status}: ${errorText}`);
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
