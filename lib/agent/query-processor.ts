export function cleanAndProcessQuery(query: string): string {
  let cleaned = query.trim();
  
  cleaned = cleaned.replace(/\s+/g, ' ');
  
  cleaned = cleaned.replace(/please/gi, '');
  cleaned = cleaned.replace(/can you/gi, '');
  cleaned = cleaned.replace(/could you/gi, '');
  cleaned = cleaned.replace(/i want/gi, '');
  cleaned = cleaned.replace(/i need/gi, '');
  cleaned = cleaned.replace(/i would like/gi, '');
  
  cleaned = cleaned.replace(/\b(um|uh|like|you know)\b/gi, '');
  
  cleaned = cleaned.replace(/\?+$/, '');
  cleaned = cleaned.replace(/\.+$/, '');
  
  cleaned = cleaned.trim();
  
  // Normalize common phrasing to be directive for better planning
  cleaned = cleaned.replace(/^find me\s+/i, 'find ');
  cleaned = cleaned.replace(/^show me\s+/i, 'show ');
  cleaned = cleaned.replace(/^give me\s+/i, 'give ');
  cleaned = cleaned.replace(/^what is\s+/i, 'find ');
  cleaned = cleaned.replace(/^tell me\s+/i, 'find ');

  // Collapse duplicate spaces again
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (cleaned.length === 0) {
    return query.trim();
  }
  
  return cleaned;
}
