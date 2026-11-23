// 화면에 보여 줄 날짜 글자를 만든다.

// 주문 상세 화면: "2026-11-13 05:07" (UTC)
export function formatDateTime(value) {
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16);
}

// 주문 목록 화면: 지금은 "11/13/2026" 모양
export function formatOrderDate(value) {
  return new Date(value).toLocaleDateString('en-US', { timeZone: 'UTC' });
}
