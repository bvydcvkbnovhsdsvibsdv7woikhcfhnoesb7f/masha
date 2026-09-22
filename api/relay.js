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
    return res.status(500).json({ error: 'DeepSeek API key not configured' });
  }

  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const parsedBody = JSON.parse(body);
    
    const { text, image, systemPrompt } = parsedBody;
    let finalUserMessage = text || "";

    // Формируем сообщение: если есть фото — отправляем как мультимодальное
    let messages = [{ role: "system", content: systemPrompt }];
    
    if (image) {
      // Мультимодальный запрос (фото + текст)
      messages.push({
        role: "user",
        content: [
          { type: "text", text: text || "Отреагируй на это фото." },
          { type: "image_url", image_url: { url: image } }
        ]
      });
    } else {
      // Только текст
      messages.push({
        role: "user",
        content: finalUserMessage
      });
    }

    // Отправляем в DeepSeek (модель с поддержкой vision)
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + DEEPSEEK_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash', // или 'deepseek-v4-flash-vision-exp'
        messages: messages,
        max_tokens: 200,
        stream: false
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek API ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "Что-то пошло не так...";

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
