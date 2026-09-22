export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  const API_KEY = 'sk-orca-JD2nKs39fTGGdUcjnm1WmB6uN5cTu3ef2qbaX9DVbFb';

  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const parsedBody = JSON.parse(body);
    
    const { text, image, systemPrompt } = parsedBody;
    let finalUserMessage = text || "";

    // ШАГ 1: Если есть фото, отправляем его в бесплатную Vision-модель
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

        if (!visionRes.ok) {
          console.error('Vision API error:', visionRes.status, await visionRes.text());
          finalUserMessage = `[Пользователь отправил фото, но не удалось его разобрать] ${text || 'Отреагируй на это фото.'}`;
        } else {
          const visionData = await visionRes.json();
          const description = visionData.choices?.[0]?.message?.content || "Не удалось разобрать фото";
          finalUserMessage = `[Пользователь отправил фото. Описание изображения: ${description}] ${text ? 'Он также написал: ' + text : 'Отреагируй на это фото.'}`;
        }
      } catch (visionError) {
        console.error('Vision request failed:', visionError);
        finalUserMessage = `[Пользователь отправил фото, но произошла ошибка при обработке] ${text || 'Отреагируй на это фото.'}`;
      }
    }

    // ШАГ 2: Отправляем в основную модель Маши с fallback
    let reply = null;
    let lastError = null;

    // Пробуем несколько моделей по очереди
    const models = [
      "orcarouter/free",
      "deepseek/deepseek-v4-flash-free",
      "qwen/qwen-2.5-72b-instruct:free"
    ];

    for (const model of models) {
      try {
        const mashaRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + API_KEY,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://masha-mf60.vercel.app',
            'X-Title': 'Masha Chat'
          },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: finalUserMessage }
            ],
            temperature: 0.85,
            max_tokens: 150
          })
        });

        if (mashaRes.ok) {
          const mashaData = await mashaRes.json();
          reply = mashaData.choices?.[0]?.message?.content;
          if (reply) break; // Успех, выходим из цикла
        } else {
          const errorText = await mashaRes.text();
          console.error(`Model ${model} failed:`, mashaRes.status, errorText);
          lastError = `${model}: ${mashaRes.status}`;
        }
      } catch (modelError) {
        console.error(`Model ${model} error:`, modelError);
        lastError = `${model}: ${modelError.message}`;
      }
    }

    if (!reply) {
      throw new Error(`Все модели не ответили. Последняя ошибка: ${lastError}`);
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(JSON.stringify({ reply }));

  } catch (e) {
    console.error("API Error:", e);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(500).send(JSON.stringify({ 
      error: String(e),
      details: e.message 
    }));
  }
}
