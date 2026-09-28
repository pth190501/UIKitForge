// Chuyển chữ có dấu về không dấu trước khi lọc [A-Za-z0-9]: nếu không, "Emi bảo trì" mất sạch ký tự có dấu
// thành `emiBOTr`. NFD tách dấu thành combining mark để xoá; riêng đ/Đ là chữ cái độc lập nên phải thay tay.
export function foldDiacritics(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
}
