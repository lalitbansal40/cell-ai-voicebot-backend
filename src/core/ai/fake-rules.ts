/** Keyword rules of the fake AI provider (shared by chat and structured answers). */
export const FAKE_RULES = {
  /** Phase 8 (checked first): wrong person, refusal, callback request. */
  wrongNumber: /\b(galat number|wrong number|yeh vyakti nahi)\b/i,
  refuse: /\b(nahi karunga|nahi dunga|won't pay|will not pay)\b/i,
  callback:
    /\b(call (karna|kariye|karo|back)|callback|baad mein call|phir se call|call me (back|later))\b/i,
  paymentClaim: /(pay|paid|bhar|jama|payment)\b.*\b(kar|ho|diya|done|gaya|made|did)/i,
  paymentTool: /payment|paid|dues/,
  promise: /\b(kal|parso|tomorrow|tak de|\d{1,2}\s*(tarikh|date))\b/i,
  transfer: /\b(insaan|human|agent se|manager|real person)\b/i,
  goodbye: /\b(bye|band karo|call cut|baad mein|later)\b/i,
  abusive: /\b(idiot|stupid|bakwas|pagal|bewakoof|shut up)\b/i,
  hinglishMarkers:
    /\b(hai|kar|kya|nahi|haan|ji|main|aap|diya|gaya|hoon|ho|tak|kal|paisa|mera|meri|bhai|kab|kaise|kyun)\b|[ऀ-ॿ]/i,
} as const;
