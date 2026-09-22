export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  const HF_TOKEN = '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';

  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const parsedBody = JSON.parse(body);
    
    const { text, image, systemPrompt } = parsedBody;
    let finalUserMessage = text || "";

    // ШАГ 1: Если есть фото
    if (image) {
      try {
        const visionRes = await fetch('https://api-inference.huggingface.co/models/Qwen/Qwen2-VL-7B-Instruct/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + HF_TOKEN,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: "Qwen/Qwen2-VL-7B-Instruct",
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
          console.error('Vision error:', await visionRes.text());
          finalUserMessage = `[Пользователь отправил фото] ${text || 'Отреагируй на фото.'}`;
        }
      } catch (e) {
        console.error('Vision failed:', e);
        finalUserMessage = `[Пользователь отправил фото] ${text || 'Отреагируй на фото.'}`;
      }
    }

    // ШАГ 2: Основная модель
    const mashaRes = await fetch('https://api-inference.huggingface.co/models/meta-llama/Llama-3.1-8B-Instruct/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + HF_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "meta-llama/Llama-3.1-8B-Instruct",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: finalUserMessage }
        ],
        max_tokens: 150,
        temperature: 0.85
      })
    });

    if (!mashaRes.ok) {
      const errorText = await mashaRes.text();
      throw new Error(`HF API ${mashaRes.status}: ${errorText}`);
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
