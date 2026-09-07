# Landing Page + Webhook (Vercel) cho quảng cáo chuyển đổi Facebook

Bộ code mẫu này gồm:
- `index.html` — landing page có sẵn Meta Pixel + form đặt hàng
- `api/lead.js` — Vercel Serverless Function đóng vai trò webhook, nhận dữ liệu form rồi gửi sự kiện lên Facebook Conversions API (CAPI)
- `.env.example` — danh sách biến môi trường cần khai báo
- `vercel.json`, `package.json` — cấu hình project

Vì bạn đã có tài khoản quảng cáo (TKQC) và sản phẩm, dưới đây là quy trình đầy đủ từ số 0 đến khi chạy được chiến dịch thật.

---

## GIAI ĐOẠN 1 — Chuẩn bị trên Meta Business Suite

### Bước 1.1 — Tạo Pixel (nếu chưa có)
1. Vào **business.facebook.com** → Events Manager
2. Data Sources → Connect Data Source → Web → đặt tên Pixel (VD: "Bon Bon Shop Pixel")
3. Ghi lại **Pixel ID** (dãy số dài) — dán vào `index.html` (2 chỗ có chữ `YOUR_PIXEL_ID`) và vào biến môi trường `FB_PIXEL_ID`

### Bước 1.2 — Tạo Access Token cho Conversions API
1. Trong Events Manager, chọn Pixel vừa tạo → tab **Settings**
2. Kéo xuống mục **Conversions API** → **Generate access token**
   - Cách này tạo token nhanh nhưng gắn với tài khoản cá nhân của bạn.
   - **Khuyến nghị chuyên nghiệp hơn**: vào Business Settings → System Users → tạo 1 System User → gán quyền vào Pixel này → generate token từ System User. Token này ổn định hơn, không bị mất khi bạn đổi mật khẩu cá nhân.
3. Copy token, điền vào biến môi trường `FB_ACCESS_TOKEN` (không đưa token này lên landing page phía client, chỉ để trên server/Vercel)

### Bước 1.3 — Xác minh domain
1. Events Manager → Brand Safety → Domains → thêm domain landing page của bạn (VD: `dathangbonbon.vercel.app` hoặc domain riêng nếu có)
2. Xác minh bằng 1 trong 3 cách Meta hướng dẫn (thêm DNS TXT record, upload file HTML, hoặc chèn meta tag)
3. Bước này quan trọng vì domain chưa xác minh sẽ bị giới hạn số sự kiện tối ưu (Aggregated Event Measurement) trên iOS

### Bước 1.4 — Cấu hình Aggregated Event Measurement (AEM)
1. Trong phần Domain vừa xác minh → **Aggregated Event Measurement** → chọn tối đa 8 sự kiện được ưu tiên
2. Kéo sự kiện **Lead** (hoặc Purchase nếu bán trực tiếp) lên vị trí ưu tiên cao nếu đó là mục tiêu chính
3. Việc này ảnh hưởng tới cách Facebook tối ưu khi không lấy được đủ dữ liệu từ thiết bị iOS

---

## GIAI ĐOẠN 2 — Deploy landing page + webhook lên Vercel

### Bước 2.1 — Cài Vercel CLI (nếu chưa có)
```bash
npm install -g vercel
```

### Bước 2.2 — Deploy
```bash
cd fb-conversion-landing
vercel login
vercel
```
Làm theo hướng dẫn trên terminal (chọn scope, tên project...). Sau khi xong, Vercel cho bạn 1 URL dạng `https://ten-project.vercel.app`.

### Bước 2.3 — Khai báo biến môi trường trên Vercel
Vào Vercel Dashboard → chọn project → **Settings → Environment Variables**, thêm:
- `FB_PIXEL_ID`
- `FB_ACCESS_TOKEN`
- `FB_TEST_EVENT_CODE` (dùng tạm để test, xoá khi chạy thật)

Sau khi thêm biến môi trường, deploy lại: `vercel --prod`

### Bước 2.4 — Cập nhật Pixel ID trong index.html
Mở `index.html`, thay `YOUR_PIXEL_ID` (2 chỗ) bằng Pixel ID thật, rồi deploy lại.

---

## GIAI ĐOẠN 3 — Kiểm thử trước khi chạy tiền thật

### Bước 3.1 — Test Events trong Events Manager
1. Events Manager → chọn Pixel → tab **Test Events**
2. Copy **Test Event Code** hiển thị ở đó, điền vào biến môi trường `FB_TEST_EVENT_CODE` trên Vercel, deploy lại
3. Mở landing page thật (URL Vercel), điền form và bấm gửi
4. Quay lại tab Test Events — bạn sẽ thấy sự kiện `Lead` xuất hiện **2 nguồn**: Browser (từ Pixel) và Server (từ CAPI) — nếu chúng được gộp thành 1 dòng có nhãn "Deduplicated", nghĩa là event_id đã hoạt động đúng

### Bước 3.2 — Kiểm tra Event Match Quality (EMQ)
1. Events Manager → Diagnostics (hoặc Overview) → xem điểm **Event Match Quality** của sự kiện Lead
2. Điểm càng cao (Facebook chấm theo thang điểm) thì tối ưu quảng cáo càng chính xác
3. Nếu điểm thấp, cân nhắc gửi thêm dữ liệu trong `user_data` (email đã hash, họ tên đầy đủ, thành phố...) — sửa trong `api/lead.js`

### Bước 3.3 — Xoá test_event_code trước khi chạy thật
Xoá biến `FB_TEST_EVENT_CODE` trên Vercel (hoặc để trống) rồi deploy lại `vercel --prod`, nếu không sự kiện thật sẽ bị đánh dấu là test và không dùng để tối ưu.

---

## GIAI ĐOẠN 4 — Tạo chiến dịch trong Ads Manager

### Bước 4.1 — Tạo Campaign
1. Ads Manager → Tạo chiến dịch
2. Mục tiêu: **Leads** (nếu tối ưu theo form đặt hàng) hoặc **Sales** (nếu có trang thanh toán riêng)
3. Chọn nơi chuyển đổi (Conversion location): **Website**

### Bước 4.2 — Tạo Ad Set
1. Chọn Pixel đã tạo ở trên, chọn sự kiện tối ưu = **Lead**
2. Đặt ngân sách, đối tượng (giới tính, độ tuổi phụ huynh có con nhỏ, vị trí địa lý...)
3. Vị trí hiển thị: có thể để Advantage+ placements (tự động) khi mới bắt đầu

### Bước 4.3 — Tạo Ad
1. Chọn creative (ảnh/video sản phẩm áo chống nắng)
2. Đường dẫn website = URL landing page Vercel của bạn, có thể thêm UTM để theo dõi:
   `https://ten-project.vercel.app/?utm_source=facebook&utm_campaign=ao-chong-nang`
3. Xuất bản chiến dịch

### Bước 4.4 — Theo dõi 24-48h đầu
- Kiểm tra Ads Manager: có bao nhiêu Lead, chi phí/lead (CPL)
- Đối chiếu số Lead trên Ads Manager với số đơn thực tế nhận được qua điện thoại/Pancake — nếu lệch nhiều, kiểm tra lại webhook có lỗi không (xem log trên Vercel: Dashboard → project → Logs)
- Sau khi có > 15-20 lượt chuyển đổi, thuật toán mới bắt đầu ra khỏi giai đoạn học (learning phase) và tối ưu ổn định hơn

---

## Ghi chú kỹ thuật quan trọng

- **event_id phải trùng khớp** giữa Pixel (client) và CAPI (server) cho cùng 1 lượt submit — code mẫu đã xử lý sẵn việc này.
- **Không để lộ `FB_ACCESS_TOKEN`** ở phía client (HTML/JS chạy trên trình duyệt) — token này chỉ nên nằm trong biến môi trường của Vercel, được dùng trong `api/lead.js` (server-side).
- Số điện thoại và email gửi lên CAPI phải được **hash SHA-256** trước — code mẫu đã hash sẵn số điện thoại.
- Nếu bạn muốn lưu lead vào Google Sheet/Pancake để chăm sóc khách, xem phần comment trong `api/lead.js` (mục "Tuỳ chọn lưu lead").
