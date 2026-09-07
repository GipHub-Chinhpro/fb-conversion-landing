// api/lead.js
// Vercel Serverless Function — đóng vai trò "webhook" nhận dữ liệu từ landing page,
// sau đó gửi sự kiện chuyển đổi lên Facebook Conversions API (CAPI, server-side).
//
// Biến môi trường cần khai báo trên Vercel (Project Settings > Environment Variables):
//   FB_PIXEL_ID          - Pixel ID của bạn
//   FB_ACCESS_TOKEN       - Access token CAPI (tạo trong Events Manager > Conversions API)
//   FB_TEST_EVENT_CODE    - (tuỳ chọn) mã test lấy trong tab "Test Events", XOÁ khi chạy thật
//   PANCAKE_API_KEY       - API Key tạo trong Pancake POS > Cấu hình > Nâng cao > Tích hợp bên thứ 3
//   PANCAKE_SHOP_ID       - Shop ID trên Pancake POS
//   PANCAKE_PAGE_ID       - ID Fanpage đang chạy quảng cáo (đã liên kết với Pancake)
//   PANCAKE_WAREHOUSE_ID  - ID kho hàng dùng để tạo đơn trên Pancake
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

// Bảng giá CHÍNH THỨC cho Áo chống nắng (nhóm AAA), cập nhật 2026-09-06.
// Tính giá ở SERVER (không tin giá gửi từ client) để tránh bị sửa giá qua DevTools.
const PRICE_BY_QTY = { 1: 99000, 2: 158000, 3: 225000 };
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
async function createPancakeOrder({ name, phone, address, product, size, color, quantity, note, price }) {
  const apiKey = process.env.PANCAKE_API_KEY;
  const shopId = process.env.PANCAKE_SHOP_ID;
  const pageId = process.env.PANCAKE_PAGE_ID;
  const warehouseId = process.env.PANCAKE_WAREHOUSE_ID;

  if (!apiKey || !shopId) {
    // Chưa cấu hình Pancake -> bỏ qua, không coi là lỗi.
    return;
  }

  try {
    const itemName = [product, size, color].filter(Boolean).join(' - ');
    const body = {
      shop_id: Number(shopId),
      bill_full_name: name,
      bill_phone_number: phone,
      page_id: pageId || undefined,
      account: pageId || undefined,
      account_name: 'Landing page quảng cáo',
      items: [
        {
          quantity: Number(quantity) || 1,
          one_time_product: true,
          variation_info: {
            name: itemName || 'Áo chống nắng chống tia UV cho bé',
            retail_price: price,
            weight: 100
          }
        }
      ],
      note: note ? `Ghi chú từ khách: ${note}` : 'Đơn tự động từ landing page quảng cáo',
      shipping_address: {
        full_name: name,
        phone_number: phone,
        address: address || ''
      },
      shipping_fee: 0,
      warehouse_id: warehouseId || undefined,
      status: 0
    };

    const res = await fetch(
      `https://pos.pages.fm/api/v1/shops/${shopId}/orders?api_key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );
    const json = await res.json();
    if (!res.ok) {
      console.error('Lỗi tạo đơn Pancake:', json);
    } else {
      console.log('Đã tạo đơn Pancake, order id:', json?.data?.id);
    }
  } catch (err) {
    console.error('Lỗi kết nối tới Pancake:', err);
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
      size,
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

    const price = getPriceForQuantity(quantity);
    const contentName = [product, size, color].filter(Boolean).join(' - ');

    // Ghi log đơn hàng đầy đủ (kể cả địa chỉ) để bạn xem trong Vercel Dashboard > Project > Logs
    // khi chưa cấu hình SHEET_WEBHOOK_URL. Không gửi địa chỉ lên Facebook (không cần cho CAPI,
    // tránh đưa PII dạng thô lên nền tảng quảng cáo).
    console.log('Lead mới:', JSON.stringify({
      name, phone, address, product, size, color, quantity, price, note, event_id
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
            content_ids: color ? [color] : undefined,
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

    const fbRes = await fetch(
      `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${accessToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventPayload)
      }
    );

    const fbJson = await fbRes.json();

    if (!fbRes.ok) {
      console.error('Lỗi gửi CAPI:', fbJson);
      // Không nên để khách hàng thấy lỗi kỹ thuật của Facebook — vẫn coi là
      // nhận lead thành công phía shop, nhưng log lại để bạn kiểm tra sau.
    }

    // 3) Tự động tạo đơn hàng bên Pancake POS để shop quản lý/lên đơn/giao hàng.
    await createPancakeOrder({ name, phone, address, product, size, color, quantity, note, price });

    // ------------------------------------------------------------------
    // (Tuỳ chọn) Lưu lead vào nơi khác để chăm sóc khách hàng, ví dụ:
    // - Google Sheet (qua Google Apps Script Web App URL)
    // - Ghi vào database (Postgres, Airtable, v.v.)
    // Bỏ comment và điền URL tương ứng nếu cần:
    //
    // await fetch(process.env.SHEET_WEBHOOK_URL, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ name, phone, address, product, size, color, quantity, price, note, event_id })
    // });
    // ------------------------------------------------------------------

    res.status(200).json({ success: true, fb_response: fbJson });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
};
