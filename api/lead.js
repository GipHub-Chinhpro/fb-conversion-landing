// api/lead.js
// Vercel Serverless Function — đóng vai trò "webhook" nhận dữ liệu từ landing page,
// sau đó gửi sự kiện chuyển đổi lên Facebook Conversions API (CAPI, server-side).
//
// Biến môi trường cần khai báo trên Vercel (Project Settings > Environment Variables):
//   FB_PIXEL_ID          - Pixel ID của bạn
//   FB_ACCESS_TOKEN       - Access token CAPI (tạo trong Events Manager > Conversions API)
//   FB_TEST_EVENT_CODE    - (tuỳ chọn) mã test lấy trong tab "Test Events", XOÁ khi chạy thật
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
      product,
      event_id,
      event_source_url,
      fbp,
      fbc
    } = body || {};

    if (!phone || !event_id) {
      res.status(400).json({ error: 'Thiếu phone hoặc event_id' });
      return;
    }

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
            content_name: product,
            currency: 'VND',
            value: 199000
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

    // ------------------------------------------------------------------
    // (Tuỳ chọn) Lưu lead vào nơi khác để chăm sóc khách hàng, ví dụ:
    // - Google Sheet (qua Google Apps Script Web App URL)
    // - Gửi vào Pancake API
    // - Ghi vào database (Postgres, Airtable, v.v.)
    // Bỏ comment và điền URL/API key tương ứng nếu cần:
    //
    // await fetch(process.env.SHEET_WEBHOOK_URL, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ name, phone, product, event_id })
    // });
    // ------------------------------------------------------------------

    res.status(200).json({ success: true, fb_response: fbJson });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
};
