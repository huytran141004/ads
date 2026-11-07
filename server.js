const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Phục vụ giao diện tĩnh từ thư mục public
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Hàng đợi tuần tự Backend (Sequential Queue Chain) - Giải quyết triệt để vấn đề Spam API
 * Dù 10 người cùng bấm "Chạy" tại cùng 1 giây, các đơn hàng sẽ được xếp vào hàng chờ
 * và gửi sang Baostar đều đặn tuần tự cách nhau 1.2 giây.
 * Điều này mô phỏng 100% thao tác của người thật, triệt tiêu nguy cơ bị Baostar khóa IP hay Rate Limit.
 */
let lastRequestChain = Promise.resolve();
const REQUEST_INTERVAL_MS = 1200; // 1.2 giây giãn cách giữa mỗi đơn

function enqueueBaostarRequest(apiCallFn) {
  const execution = lastRequestChain.then(async () => {
    // Đảm bảo khoảng cách an toàn trước khi bắn đơn tiếp theo
    await new Promise((resolve) => setTimeout(resolve, REQUEST_INTERVAL_MS));
    return apiCallFn();
  });

  // Đảm bảo chuỗi hàng đợi không bị gãy nếu 1 đơn nào đó bị lỗi
  lastRequestChain = execution.catch(() => {});
  return execution;
}

/**
 * Route kiểm tra sức khỏe hệ thống (Health Check)
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    apiConfigured: Boolean(process.env.BAOSTAR_API_KEY && process.env.BAOSTAR_API_KEY !== 'your_api_key_here')
  });
});

/**
 * Route lấy danh sách dịch vụ trực tiếp từ nhà cung cấp SMM
 * GET /api/services
 */
app.get('/api/services', async (req, res) => {
  try {
    const apiKey = process.env.BAOSTAR_API_KEY;
    const apiUrl = process.env.BAOSTAR_API_URL || 'https://www.baostar.org/api/v2';

    if (!apiKey || apiKey === 'your_api_key_here') {
      return res.status(500).json({
        success: false,
        message: 'Lỗi cấu hình: BAOSTAR_API_KEY chưa được thiết lập trong file .env.'
      });
    }

    const response = await axios.post(
      apiUrl,
      {
        key: apiKey,
        action: 'services',
        token_: apiKey
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 25000
      }
    );

    if (Array.isArray(response.data)) {
      return res.json({
        success: true,
        services: response.data
      });
    }

    return res.status(400).json({
      success: false,
      message: response.data?.error || response.data?.message || 'Không lấy được danh sách dịch vụ.',
      raw: response.data
    });
  } catch (err) {
    console.error('[Services Error] Lỗi khi lấy danh sách dịch vụ:', err.message);
    return res.status(err.response?.status || 500).json({
      success: false,
      message: err.response?.data?.error || err.message || 'Lỗi kết nối khi lấy danh sách dịch vụ'
    });
  }
});

/**
 * Route tạo 1 đơn hàng lẻ tăng comment Facebook qua Baostar SMM Panel API
 * POST /api/order
 * Body: { link: string, comments: string }
 */
app.post('/api/order', async (req, res) => {
  try {
    const { link, comments } = req.body;

    // 1. Validate link bài viết
    if (!link || typeof link !== 'string' || !link.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Link bài viết không được để trống.'
      });
    }

    const trimmedLink = link.trim();

    // 2. Validate và chuẩn hóa danh sách bình luận (lọc bỏ dòng trống, trim khoảng trắng)
    if (!comments || typeof comments !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Nội dung bình luận không được để trống.'
      });
    }

    const commentList = comments
      .split(/\r?\n/)
      .map(c => c.trim())
      .filter(c => c.length > 0);

    if (commentList.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Danh sách bình luận không có nội dung hợp lệ (tất cả các dòng đều trống).'
      });
    }

    const quantity = commentList.length;
    const joinedComments = commentList.join('\n');

    // 3. Kiểm tra API Key từ biến môi trường Server
    const apiKey = process.env.BAOSTAR_API_KEY;
    const serviceId = (req.body.serviceId || '').trim() || process.env.SERVICE_ID;
    const apiUrl = process.env.BAOSTAR_API_URL || 'https://www.baostar.org/api/v2';

    if (!apiKey || apiKey === 'your_api_key_here') {
      return res.status(500).json({
        success: false,
        message: 'Lỗi cấu hình Server: BAOSTAR_API_KEY chưa được thiết lập trong file .env.'
      });
    }

    if (!serviceId || serviceId === 'your_service_id_here') {
      return res.status(400).json({
        success: false,
        message: 'Chưa có Service ID. Vui lòng chọn gói dịch vụ trên web hoặc cấu hình trong file .env.'
      });
    }

    // 4. Chuẩn bị payload tương thích cả Native Baostar API và SMM Panel v2
    const payload = {
      // Định dạng Native API của Baostar (theo F12 Network DevTools):
      object_id: trimmedLink,
      list_message: joinedComments,
      package_name: serviceId, // ví dụ: "facebook_comment_sv1" hoặc mã ID
      notes: '',
      token_: apiKey,

      // Định dạng SMM Panel v2 (phòng khi gọi endpoint chuẩn /api/v2):
      key: apiKey,
      action: 'add',
      service: serviceId,
      link: trimmedLink,
      comments: joinedComments,
      quantity: quantity
    };

    console.log(`[Queue Worker] Đang xếp hàng đơn: Link="${trimmedLink}" | Package="${serviceId}" | Số comment=${quantity}`);

    // 5. Gửi request sang Baostar thông qua Hàng đợi tuần tự an toàn (1.2s / đơn)
    const response = await enqueueBaostarRequest(() => {
      return axios.post(apiUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 30000 // 30s timeout
      });
    });

    const data = response.data;

    // 6. Xử lý phản hồi từ API (Hỗ trợ cả SMM Panel v2 và Baostar Native API)
    // Trường hợp 1: Chuẩn SMM Panel ({ "order": 12345 })
    if (data && (data.order !== undefined || data.order_id !== undefined)) {
      const orderId = data.order !== undefined ? data.order : data.order_id;
      console.log(`[Queue Worker] Thành công! Order ID: ${orderId}`);
      return res.json({
        success: true,
        orderId: orderId,
        message: 'Tạo đơn thành công!'
      });
    }

    // Trường hợp 2: Baostar Native API ({ "status": 200/true, "message": "...", "data": { "id": ... } })
    if (data && (data.status === 200 || data.status === true || data.code === 200 || data.success === true)) {
      const orderId = data.data?.id || data.data?.order_id || data.id || data.order_id || 'OK';
      console.log(`[Queue Worker] Thành công (Native API)! Order ID: ${orderId}`);
      return res.json({
        success: true,
        orderId: orderId,
        message: data.message || 'Tạo đơn thành công!'
      });
    }

    // Trường hợp lỗi từ API
    if (data && (data.error || (data.message && (data.status === false || data.status >= 400 || data.code >= 400 || !data.success)))) {
      const errorMsg = data.error || data.message;
      const formattedMsg = typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg);
      console.warn(`[Queue Worker] API từ chối đơn: ${formattedMsg}`);
      return res.status(400).json({
        success: false,
        message: `Hệ thống từ chối: ${formattedMsg}`
      });
    }

    // Trường hợp phản hồi không xác định
    console.warn('[Queue Worker] Phản hồi bất thường từ API:', data);
    return res.status(400).json({
      success: false,
      message: 'Phản hồi không xác định từ hệ thống API: ' + JSON.stringify(data)
    });

  } catch (err) {
    console.error('[Backend Error] Lỗi khi xử lý đơn hàng:', err.message);

    const apiErrorMessage =
      err.response?.data?.error ||
      err.response?.data?.message ||
      err.message ||
      'Không thể kết nối đến máy chủ API.';

    return res.status(err.response?.status || 500).json({
      success: false,
      message: `Lỗi kết nối API: ${apiErrorMessage}`
    });
  }
});

// Điều hướng fallback trả về index.html cho các route SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Khởi động server
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Baostar Batch Order Tool đang chạy tại:`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`====================================================`);
});

