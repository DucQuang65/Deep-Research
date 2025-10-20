DeepSearch Workflow
Mục tiêu dự án

DeepSearch Workflow là một hệ thống nghiên cứu chuyên sâu tự động, hỗ trợ người dùng thực hiện quy trình nghiên cứu từ xác nhận chủ đề, lập kế hoạch, phân tích, tổng hợp báo cáo, đến xuất file và thu thập phản hồi.
Ứng dụng sử dụng AI để tự động hóa các bước nghiên cứu và tạo báo cáo chuyên sâu, phù hợp với học thuật, doanh nghiệp, hoặc cá nhân cần nghiên cứu chuyên đề.

Tech Stack: Node.js, Express.js / REST API / SSE, OpenRouter API, Google CSE, Playwright (crawler, cookie bypass, HTML cleanup), PDFJSDIST, DOCX generation

Cài đặt và chạy local
Yêu cầu môi trường

Node.js >= 18

Biến môi trường API key:

OPENROUTER_API_KEY

GOOGLE_API_KEY

GOOGLE_CSE_ID

Bạn có thể tạo file .env dựa trên mẫu .env.example (không commit .env thật lên GitHub)

Cài đặt dependencies
npm install

Khởi động server
npm start


hoặc

node server.js

Truy cập API

Server mặc định chạy tại: http://localhost:3000

Các endpoint chính nằm dưới /deepsearch


Workflow Step-by-Step:

- Ping kiểm tra kết nối

GET /deepsearch/ping

- Xác nhận chủ đề nghiên cứu

POST /deepsearch/confirm/stream

- Lập kế hoạch nghiên cứu

POST /deepsearch/plan/stream

- Chỉnh sửa kế hoạch

POST /deepsearch/plan/edit/stream

- Sinh các câu hỏi con (subquestions)

POST /deepsearch/subquestions/stream

- Thực thi nghiên cứu (Google Search + Gemini)

POST /deepsearch/execute/stream

- Tổng hợp báo cáo chuyên sâu

POST /deepsearch/report/stream

- Xuất file báo cáo DOCX

POST /deepsearch/generate-file/stream



Một số endpoint tiêu biểu

/deepsearch/stream: Thực hiện toàn bộ quy trình (SSE streaming)

/deepsearch/plan/stream: Lập kế hoạch (SSE streaming)

/deepsearch/report/stream: Tổng hợp báo cáo (SSE streaming)

/deepsearch/generate-file/stream: Xuất file DOCX (SSE streaming)


Lưu ý

Các endpoint streaming sử dụng SSE; client cần hỗ trợ SSE để nhận dữ liệu liên tục.

Đảm bảo các API key đã được thiết lập trong môi trường trước khi chạy.

Báo cáo được lưu tại thư mục reports.
