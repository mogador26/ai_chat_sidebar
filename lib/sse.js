// Parseur Server-Sent Events sur le corps d'une réponse fetch (ReadableStream).
// Gère CRLF / CR / LF, les chunks coupés n'importe où, les commentaires et les data: multi-lignes.

/**
 * @param {ReadableStream<Uint8Array>} body
 * @yields {{event: string, data: string, id?: string}}
 */
export async function* parseSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "message";
  let data = [];
  let id;

  const dispatch = () => {
    if (!data.length) {
      event = "message";
      return null;
    }
    const ev = { event, data: data.join("\n"), id };
    event = "message";
    data = [];
    return ev;
  };

  const handleLine = (line) => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return null;
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value || "message";
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
    return null;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Un "\r" final peut être suivi d'un "\n" dans le chunk suivant : on le retient.
      const endsCR = buf.endsWith("\r");
      let work = endsCR ? buf.slice(0, -1) : buf;
      work = work.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const lines = work.split("\n");
      const tail = lines.pop();
      buf = tail + (endsCR ? "\r" : "");
      for (const line of lines) {
        const ev = handleLine(line);
        if (ev) yield ev;
      }
    }
    buf += decoder.decode();
    const rest = buf.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    for (const line of rest.split("\n")) {
      const ev = handleLine(line);
      if (ev) yield ev;
    }
    const last = dispatch();
    if (last) yield last;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* flux déjà fermé */
    }
  }
}
