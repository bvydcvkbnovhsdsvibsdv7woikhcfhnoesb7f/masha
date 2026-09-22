export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  const API_KEY = process.env.OPENROUTER_API_KEY;

  if (!API_KEY) {
    console.error('API_KEY not found in environment variables');
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const parsedBody = JSON.parse(body);
    
    const { text, image, systemPrompt } = parsedBody;
    let finalUserMessage = text || "";

    // ШАГ 1: Vision-модели (если есть фото)
    if (image) {
      const visionModels = [
        "meta-llama/llama-3.2-11b-vision-instruct:free",
        "qwen/qwen-2-vl-7b-instruct:free"
      ];
      
      let visionSuccess = false;
      
      for (const model of visionModels) {
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
              model: model,
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
            visionSuccess = true;
            break;
          } else {
            const errText = await visionRes.text();
            console.error(`Vision ${model} failed: ${visionRes.status}`, errText);
          }
        } catch (e) {
          console.error(`Vision ${model} error:`, e);
        }
      }
      
      if (!visionSuccess) {
        finalUserMessage = `[Пользователь отправил фото] ${text || 'Отреагируй на фото.'}`;
      }
    }

    // ШАГ 2: Текстовые модели (ОБНОВЛЕННЫЙ СПИСОК БЕСПЛАТНЫХ)
    const textModels = [
      "meta-llama/llama-3-8b-instruct:free",
      "qwen/qwen-2.5-72b-instruct:free",
      "mistralai/mistral-7b-instruct:free",
      "google/gemma-2-9b-it:free"
    ];
    
    let reply = null;
    
    for (const model of textModels) {
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
          if (reply) {
            console.log(`Success with model: ${model}`);
            break;
          }
        } else {
          const errText = await mashaRes.text();
          console.error(`Model ${model} failed: ${mashaRes.status}`, errText);
        }
      } catch (e) {
        console.error(`Model ${model} error:`, e);
      }
    }

    if (!reply) {
      throw new Error('Все бесплатные модели временно недоступны. Попробуйте через 5 минут.');
    }

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
