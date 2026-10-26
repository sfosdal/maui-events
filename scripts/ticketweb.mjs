// TicketWeb event pages (the Crocodile's box office) read without a browser:
// the page answers a plain fetch and embeds its event as Next.js flight data —
// a JS string with the JSON inside it, quotes escaped. The two parts that
// matter: `status.name` ("On Sale", "Sold Out", "Off Sale", …) and
// `eventSections` (the ticket types on sale, each with an availability letter
// H/M/L rather than a count, and the price range). Used by soldout-check.mjs;
// pure, so sources.test-style fixtures cover it (ticketweb.test.mjs).

export function ticketWebId(url) { // the numeric event id at the end of a TicketWeb event URL, or null
  const m = (url || '').match(/ticketweb\.com\/event\/[^/?#]+\/(\d+)/i);
  return m ? m[1] : null;
}

function balanced(text, from) { // the JSON object starting at text[from] === '{'
  let depth = 0, inStr = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return text.slice(from, i + 1); }
  }
  return null;
}

// → { status: 'available' | 'soldout' | 'presale' | 'none' | 'unknown', primary, resale, fromPrimary?, note }
// in the shape soldout-check.mjs writes for the Ticketmaster rooms (primary is
// null when on sale: TicketWeb gives letters, not counts).
export function readTicketWeb(html, now = Date.now()) {
  const text = String(html || '').replace(/\\"/g, '"');
  const si = text.indexOf('"eventSections":{');
  if (si < 0) return { status: 'unknown', note: 'not a TicketWeb event page' }; // e.g. a listing TicketWeb hands off to Opendate
  let sections = [], priceMin = null;
  try {
    const es = JSON.parse(balanced(text, si + '"eventSections":'.length));
    sections = Array.isArray(es.sections) ? es.sections : [];
    priceMin = es.priceRange && typeof es.priceRange.min === 'number' ? es.priceRange.min : null;
  } catch { /* unreadable sections: the status name still decides */ }
  const st = text.match(/"status":\{"dates":\{([^{}]*)\},"message":(?:null|"(?:[^"\\]|\\.)*"),"messageTitle":(?:null|"(?:[^"\\]|\\.)*"),"name":"([^"]*)"/);
  const name = st ? st[2] : '';
  const onSale = st && (st[1].match(/"onSaleTime":"([^"]+)"/) || [])[1];
  if (/^sold out$/i.test(name)) return { status: 'soldout', primary: 0, resale: 0, note: 'page says Sold Out' };
  if (/^on sale$/i.test(name)) {
    const open = sections.filter((s) => !s.isSoldOut);
    if (!sections.length) return { status: 'none', primary: null, resale: 0, note: 'On Sale, no ticket types listed' };
    if (!open.length) return { status: 'soldout', primary: 0, resale: 0, note: `every ticket type sold out (${sections.length})` };
    const letters = [...new Set(open.map((s) => s.ismAvailability).filter(Boolean))].join('/');
    return { status: 'available', primary: null, resale: 0, ...(priceMin != null ? { fromPrimary: priceMin } : {}), note: `${open.length} of ${sections.length} ticket type${sections.length === 1 ? '' : 's'} on sale${letters ? ', availability ' + letters : ''}, no count` };
  }
  if (/^off sale$/i.test(name)) {
    if (onSale && Date.parse(onSale) > now) return { status: 'presale', note: `Off Sale until ${onSale.slice(0, 10)}` };
    return { status: 'none', primary: null, resale: 0, note: 'page says Off Sale' };
  }
  if (name) return { status: 'unknown', note: `page says ${name}` }; // Cancelled, Postponed, …: nothing about tickets
  return { status: 'unknown', note: 'no status on the page' };
}
