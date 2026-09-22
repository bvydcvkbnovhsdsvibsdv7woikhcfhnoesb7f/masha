export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  const API_KEY = process.env.OPENROUTER_API_KEY;

  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const parsedBody = JSON.parse(body);
    
    const { text, image, systemPrompt } = parsedBody;
    let finalUserMessage = text || "";

    // ШАГ 1: Vision-модели (актуальные бесплатные)
    if (image) {
      const visionModels = [
        "qwen/qwen-2.5-vl-7b-instruct:free",
        "meta-llama/llama-3.2-11b-vision-instruct:free",
        "google/gemma-3-4b-vl:free"
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

    // ШАГ 2: Текстовые модели (актуальные бесплатные)
    const textModels = [
      "deepseek/deepseek-chat-v3-0324:free",
      "qwen/qwen3-235b-a22b:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "google/gemma-3-4b-it:free"
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
          if (reply) break;
        } else {
          const errText = await mashaRes.text();
          console.error(`Model ${model} failed: ${mashaRes.status}`, errText);
        }
      } catch (e) {
        console.error(`Model ${model} error:`, e);
      }
    }

    if (!reply) {
      throw new Error('Все модели не ответили. Проверь лимиты на OpenRouter.');
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
