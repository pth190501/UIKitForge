// Chuyển chữ có dấu về không dấu trước khi lọc [A-Za-z0-9]: nếu không, "Emi bảo trì" mất sạch ký tự có dấu
// thành `emiBOTr`. NFD tách dấu thành combining mark để xoá; riêng đ/Đ là chữ cái độc lập nên phải thay tay.
// SwiftLint identifier_name/type_name mặc định cảnh báo khi > 40 ký tự (CI chạy --strict nên cảnh báo = fail).
// Chừa chỗ cho hậu tố khi trùng tên (`title2`) hoặc `View` — layer text dài (cả câu) rất dễ vượt ngưỡng.
export const MAX_IDENTIFIER_LENGTH = 36

// Ghép các từ đã viết hoa chữ đầu tới khi chạm giới hạn — cắt theo từ để tên vẫn đọc được.
export function joinWordsCapped(words, max = MAX_IDENTIFIER_LENGTH) {
  let result = ''
  for (const word of words) {
    if (result && result.length + word.length > max) break
    result += word
  }
  return result.slice(0, max)
}

export function foldDiacritics(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
}
