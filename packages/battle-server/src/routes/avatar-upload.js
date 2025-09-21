/* packages/battle-server/middleware/avatar-upload.js (ESM)
 * - 아바타 업로드 전용 Multer 미들웨어
 * - 프로젝트 기본 구조(public/uploads/avatars) 그대로 사용
 * - 파일 크기/확장자 검증 + 에러 메시지 일원화
 */

import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';

// 기본 업로드 루트: packages/battle-server/public/uploads/avatars
// index.js 위치 기준으로 public 디렉토리 아래를 쓰므로, 외부에서 절대경로를 넘기지 않으면
// process.cwd() 기준 상대경로로 동작합니다(현 프로젝트 구조와 동일).
const DEFAULT_SUBDIR = 'public/uploads/avatars';

// 허용 포맷
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
]);

function ensureDirSync(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    // 디렉토리 생성 실패는 이후 multer 단계에서 에러가 납니다.
  }
}

/**
 * 파일명: <epoch>_<rand8>.<ext>
 */
function makeFileName(originalName) {
  const extRaw = path.extname(originalName || '') || '.png';
  // 확장자 화이트리스트(미지정 또는 허용 외 -> .png)
  const safeExt = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extRaw.toLowerCase())
    ? extRaw
    : '.png';

  const rand = Math.random().toString(16).slice(2, 10);
  return `${Date.now()}_${rand}${safeExt}`;
}

/**
 * 아바타 업로더 팩토리
 * @param {object} opts
 * @param {string} [opts.rootDir] - 업로드 디렉토리 절대/상대 경로 (기본: public/uploads/avatars)
 * @param {number} [opts.maxSizeMB] - 용량 제한(MB, 기본 3MB)
 * @returns {{ upload: import('multer').Multer, route: Function }}
 */
export function createAvatarUploader(opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_SUBDIR;
  const maxSizeMB = Number(process.env.AVATAR_MAX_SIZE_MB || opts.maxSizeMB || 3);
  const maxSize = Math.max(1, maxSizeMB) * 1024 * 1024;

  ensureDirSync(rootDir);

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        ensureDirSync(rootDir);
        cb(null, rootDir);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      try {
        cb(null, makeFileName(file?.originalname || 'avatar.png'));
      } catch (err) {
        cb(err);
      }
    }
  });

  const fileFilter = (req, file, cb) => {
    if (!file?.mimetype || !ALLOWED_MIME.has(file.mimetype)) {
      const msg = 'INVALID_FILE_TYPE';
      // Multer의 fileFilter에서 에러를 넘기면 500이 날 수 있으니, false + 커스텀 이유 전달
      return cb(null, false, new Error(msg));
    }
    cb(null, true);
  };

  const upload = multer({
    storage,
    limits: { fileSize: maxSize },
    fileFilter
  });

  /**
   * 라우트 핸들러(Express)
   * 사용 예) app.post('/api/upload/avatar', avatar.route());
   * 성공: { ok:true, url:'/uploads/avatars/....png' }
   */
  function route(fieldName = 'avatar') {
    const single = upload.single(fieldName);

    return (req, res) => {
      single(req, res, (err) => {
        if (err && err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ ok: false, error: 'FILE_TOO_LARGE', maxSizeMB });
        }
        if (err) {
          return res.status(400).json({ ok: false, error: 'UPLOAD_ERROR', detail: err.message || String(err) });
        }
        if (!req.file) {
          // fileFilter로 떨어진 경우 등
          return res.status(400).json({ ok: false, error: 'NO_VALID_FILE' });
        }

        // public/ 하위는 정적으로 서비스됨 → 클라이언트엔 /uploads/avatars/... 로 제공
        const relUrl = req.file.path
          .replace(/\\/g, '/')
          .replace(/^.*?public\//, '/');

        return res.json({ ok: true, url: relUrl });
      });
    };
  }

  return { upload, route };
}

/**
 * 간편 마운트 헬퍼
 * 사용 예)
 *   import { mountAvatarUpload } from './middleware/avatar-upload.js';
 *   mountAvatarUpload(app, '/api/upload/avatar');
 */
export function mountAvatarUpload(app, endpoint = '/api/upload/avatar', opts = {}) {
  const { route } = createAvatarUploader(opts);
  app.post(endpoint, route('avatar'));
}

export default createAvatarUploader;
