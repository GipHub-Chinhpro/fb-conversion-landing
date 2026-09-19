// api/lead-body.js
// Vercel Serverless Function — webhook RIÊNG cho landing page "Body lông nhung"
// (body-long-nhung.html). Cố tình KHÔNG dùng chung route với api/lead.js (trang Áo
// chống nắng đang chạy sống) để sửa/lỗi ở dòng sản phẩm này không thể ảnh hưởng
// dòng sản phẩm kia — xem [[landing-page-facebook-pancake]] mục "Sự cố vận hành"
// (lần đứt đồng bộ do sửa nhầm biến môi trường dùng chung 12-17/9/2026).
//
// Toàn bộ logic gửi CAPI + tạo đơn Pancake COPY NGUYÊN VĂN từ api/lead.js (đã chạy
// ổn định trên production) — chỉ đổi bảng giá và tên sản phẩm mặc định. Dùng CHUNG
// biến môi trường Vercel với api/lead.js (cùng Pixel, cùng Fanpage/Pancake):
//   FB_PIXEL_ID, FB_ACCESS_TOKEN, FB_TEST_EVENT_CODE (tuỳ chọn)
//   PANCAKE_API_KEY, PANCAKE_SHOP_ID, PANCAKE_PAGE_ID, PANCAKE_WAREHOUSE_ID
//
// Chạy tốt trên Node.js 18+ (Vercel dùng sẵn, có global fetch, không cần cài thêm thư viện).

const crypto = require('crypto');

function sha256(value) {
  if (!value) return undefined;
  const normalized = String(value).trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function normalizePhone(phone) {
  if (!phone) return undefined;
  // Chuẩn hoá số điện thoại VN về dạng quốc tế không dấu +, ví dụ 0901234567 -> 84901234567
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '84' + digits.slice(1);
  return digits;
}

// Gọi 1 API bên ngoài có giới hạn thời gian chờ riêng — tránh trường hợp Facebook
// hoặc Pancake phản hồi chậm kéo dài làm cả hàm bị Vercel cắt ngang giữa chừng vì
// vượt quá 10 giây (giới hạn cứng của gói Hobby, không cấu hình lại được).
// Phát hiện 2026-09-19: /api/lead và /api/lead-body đều từng bị
// "FUNCTION_INVOCATION_TIMEOUT" vì gọi Facebook rồi mới gọi Pancake LẦN LƯỢT — cộng
// dồn thời gian dễ vượt 10 giây. Sửa: giới hạn mỗi API 8 giây + gọi SONG SONG (xem bên dưới).
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Bảng giá CHÍNH THỨC cho Body lông nhung (nhóm C1-C5), cập nhật 2026-09-19:
// 1 bộ 169k + 20k ship = 189k | Combo 2 bộ 329k (miễn ship) | Combo 3 bộ 449k (miễn ship).
// Tính giá ở SERVER (không tin giá gửi từ client) để tránh bị sửa giá qua DevTools.
const PRICE_BY_QTY = { 1: 189000, 2: 329000, 3: 449000 };
function getPriceForQuantity(quantity) {
  const qty = Number(quantity) || 1;
  return PRICE_BY_QTY[qty] || PRICE_BY_QTY[1];
}

// Tự động tạo đơn hàng bên Pancake POS (đã liên kết với Fanpage đang chạy quảng cáo)
// để shop quản lý/lên đơn/giao hàng như đơn nhắn tin bình thường.
// Địa chỉ khách nhập là text tự do (không có mã Tỉnh/Huyện/Xã của Pancake), nên đơn
// tạo ra sẽ có cảnh báo "thiếu thông tin địa chỉ" — nhân viên chỉ cần xác nhận lại
// địa chỉ với khách trước khi giao, giống cách vẫn làm khi chốt đơn qua Messenger.
// Lỗi ở bước này KHÔNG làm hỏng phản hồi cho khách hàng trên landing page.
//
// "items" là danh sách bộ cụ thể khách đã chọn Size + Mẫu trên landing page, ví dụ:
//   [{ size: 'Size 2 (7-9kg)', color: 'C1 - Khủng long xanh', quantity: 1 },
//    { size: 'Size 4 (14-17kg)', color: 'C3 - Pikachu', quantity: 1 }]
// Bảng size dùng đúng bảng size chính thức của dòng Body lông thú 4-25kg (nguồn:
// notes/22 san-pham.md dùng cho bot Messenger — Size1 4-6kg...Size5 18-25kg, chung cho cả 5 mẫu).
// Mỗi phần tử sẽ thành 1 dòng sản phẩm riêng bên Pancake, để shop biết đúng
// size/mẫu từng bộ thay vì chỉ 1 dòng gộp chung như trước.
async function createPancakeOrder({ name, phone, address, product, items, quantity, note, price }) {
  const apiKey = process.env.PANCAKE_API_KEY;
  const shopId = process.env.PANCAKE_SHOP_ID;
  const pageId = process.env.PANCAKE_PAGE_ID;
  const warehouseId = process.env.PANCAKE_WAREHOUSE_ID;

  if (!apiKey || !shopId) {
    // Chưa cấu hình Pancake -> bỏ qua, không coi là lỗi.
    return;
  }

  try {
    // Pancake tự tính tổng tiền = retail_price x quantity, còn "price" ở đây là
    // TỔNG giá combo (đã tính theo bảng giá combo, không phải giá từng bộ).
    // Nên phải quy đổi ngược ra đơn giá/bộ để Pancake nhân lại ra đúng tổng tiền,
    // tránh bị nhân đôi (VD combo 2 bộ 336k mà gửi sai sẽ thành 672k).
    const qty = Number(quantity) || 1;
    const unitPrice = Math.round(price / qty);

    const pancakeItems = (Array.isArray(items) && items.length ? items : [{ quantity: qty }])
      .map(it => ({
        quantity: Number(it.quantity) || 1,
        one_time_product: true,
        variation_info: {
          name: [product, it.size, it.color].filter(Boolean).join(' - ') || 'Body lông nhung cho bé',
          retail_price: unitPrice,
          weight: 200
        }
      }));

    // Ghi rõ breakdown từng bộ vào ghi chú đơn để nhân viên lên đơn dễ đối chiếu.
    const breakdown = Array.isArray(items) && items.length
      ? items.map(it => `${it.size || ''} - ${it.color || ''} x${it.quantity}`).join(', ')
      : '';
    const noteParts = ['[Body lông nhung]'];
    if (note) noteParts.push(`Ghi chú từ khách: ${note}`);
    if (breakdown) noteParts.push(`Chi tiết: ${breakdown}`);
    const finalNote = noteParts.join(' | ');

    const body = {
      shop_id: Number(shopId),
      bill_full_name: name,
      bill_phone_number: phone,
      page_id: pageId || undefined,
      account: pageId || undefined,
      account_name: 'Landing page quảng cáo - Body lông nhung',
      items: pancakeItems,
      note: finalNote,
      shipping_address: {
        full_name: name,
        phone_number: phone,
        address: address || ''
      },
      shipping_fee: 0,
      warehouse_id: warehouseId || undefined,
      status: 0
    };

    const res = await fetchWithTimeout(
      `https://pos.pages.fm/api/v1/shops/${shopId}/orders?api_key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      },
      8000
    );
    const json = await res.json();
    if (!res.ok) {
      console.error('Lỗi tạo đơn Pancake (body lông nhung):', json);
    } else {
      console.log('Đã tạo đơn Pancake (body lông nhung), order id:', json?.data?.id);
    }
  } catch (err) {
    console.error('Lỗi kết nối tới Pancake (body lông nhung, có thể do timeout 8s):', err);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const {
      name,
      phone,
      address,
      product,
      items, // [{ size, color, quantity }, ...] - "size" mang giá trị cân nặng, vd "8kg"
      size, // giữ lại để tương thích payload cũ (nếu có)
      color,
      quantity,
      note,
      event_id,
      event_source_url,
      fbp,
      fbc
    } = body || {};

    if (!phone || !event_id) {
      res.status(400).json({ error: 'Thiếu phone hoặc event_id' });
      return;
    }

    // Payload cũ (không có items) vẫn được hỗ trợ để không gãy nếu có bản cache cũ của trang.
    const resolvedItems = Array.isArray(items) && items.length
      ? items
      : [{ size, color, quantity: Number(quantity) || 1 }];

    const price = getPriceForQuantity(quantity);
    const contentName = resolvedItems
      .map(it => [product, it.size, it.color].filter(Boolean).join(' - '))
      .join(' + ');
    const uniqueColors = [...new Set(resolvedItems.map(it => it.color).filter(Boolean))];

    // Ghi log đơn hàng đầy đủ (kể cả địa chỉ) để xem trong Vercel Dashboard > Project > Logs.
    // Không gửi địa chỉ lên Facebook (không cần cho CAPI, tránh đưa PII dạng thô lên nền tảng quảng cáo).
    console.log('Lead mới (body lông nhung):', JSON.stringify({
      name, phone, address, product, items: resolvedItems, quantity, price, note, event_id
    }));

    const pixelId = process.env.FB_PIXEL_ID;
    const accessToken = process.env.FB_ACCESS_TOKEN;
    if (!pixelId || !accessToken) {
      console.error('Thiếu FB_PIXEL_ID hoặc FB_ACCESS_TOKEN trong biến môi trường');
      res.status(500).json({ error: 'Server chưa cấu hình đầy đủ' });
      return;
    }

    // Lấy IP thật của khách (Vercel truyền qua header x-forwarded-for)
    const forwarded = req.headers['x-forwarded-for'];
    const clientIp = forwarded ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const eventPayload = {
      data: [
        {
          event_name: 'Lead',
          event_time: Math.floor(Date.now() / 1000),
          event_id: event_id, // PHẢI trùng với eventID đã bắn ở Pixel client-side để Facebook loại trùng
          event_source_url: event_source_url,
          action_source: 'website',
          user_data: {
            ph: [sha256(normalizePhone(phone))],
            fn: name ? [sha256(name.split(' ')[0])] : undefined,
            client_ip_address: clientIp,
            client_user_agent: userAgent,
            fbp: fbp || undefined,
            fbc: fbc || undefined
          },
          custom_data: {
            content_name: contentName,
            content_ids: uniqueColors.length ? uniqueColors : undefined,
            num_items: Number(quantity) || 1,
            currency: 'VND',
            value: price
          }
        }
      ]
    };

    // Chỉ thêm test_event_code khi có khai báo (giai đoạn test trong Events Manager)
    if (process.env.FB_TEST_EVENT_CODE) {
      eventPayload.test_event_code = process.env.FB_TEST_EVENT_CODE;
    }

    // Gọi CAPI (Facebook) và tạo đơn Pancake CÙNG LÚC (song song) thay vì lần lượt —
    // 2 việc này độc lập nhau, chạy song song giảm gần một nửa thời gian chờ so với
    // chạy tuần tự, tránh bị Vercel cắt ngang do vượt quá 10 giây (giới hạn cứng gói
    // Hobby — đã từng xảy ra thật, xem Vercel Logs 2026-09-19, timeout cả 2 route).
    const [fbJson] = await Promise.all([
      fetchWithTimeout(
        `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${accessToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(eventPayload)
        },
        8000
      )
        .then(async (fbRes) => {
          const json = await fbRes.json();
          if (!fbRes.ok || json.error) {
            console.error('Loi gui CAPI (body long nhung, Facebook tu choi/bao loi su kien):', JSON.stringify(json));
            // Khong nen de khach hang thay loi ky thuat cua Facebook - van coi la
            // nhan lead thanh cong phia shop, nhung LUON log lai de kiem tra sau.
            // Day la dau hieu DUY NHAT khi Facebook tu choi su kien that su (vd sai/het
            // han FB_ACCESS_TOKEN, sai FB_PIXEL_ID) - kiem tra dinh ky Vercel Runtime
            // Logs, dac biet ngay sau khi doi bien moi truong dung chung voi api/lead.js
            // (xem Su co 2 trong landing-page-facebook-pancake.md).
          } else if (Array.isArray(json.messages) && json.messages.length > 0) {
            console.warn('CAPI thanh cong nhung Facebook co canh bao (body long nhung):', JSON.stringify(json.messages));
          }
          return json;
        })
        .catch((err) => {
          console.error('Lỗi gửi CAPI (body lông nhung, timeout 8s hoặc mất kết nối):', err);
          return null;
        }),
      createPancakeOrder({ name, phone, address, product, items: resolvedItems, quantity, note, price })
    ]);

    res.status(200).json({ success: true, fb_response: fbJson });
  } catch (err) {
    console.error('Webhook error (body lông nhung):', err);
    res.status(500).json({ error: 'Internal error' });
  }
};
