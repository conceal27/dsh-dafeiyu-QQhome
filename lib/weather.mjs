// 真实天气：IP 定位（失败则用配置的城市坐标）+ open-meteo 当前天气。
// 南方不会下雪：小雪只在气温 ≤ 2℃ 且天气码是雪时才报；否则按雨处理。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CACHE_TTL = 30 * 60 * 1000;
const DEFAULT_LAT = 39.9042;
const DEFAULT_LON = 116.4074;

function paths(home = os.homedir()) {
  return path.join(home, '.dsh', 'qq-fish', 'weather.json');
}
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  } catch {}
}

/** 天气码 → 我们的小屋天气 */
export function mapWeatherCode(code, tempC) {
  const c = Number(code);
  const t = Number(tempC);
  if (!Number.isFinite(c)) return 'sunny';
  if (c === 0) return 'sunny';
  if (c >= 1 && c <= 3) return 'cloudy';
  if (c === 45 || c === 48) return 'cloudy';
  if (c >= 51 && c <= 67) return 'rain';
  if (c >= 80 && c <= 82) return 'rain';
  if (c >= 95) return 'storm';
  if (c >= 71 && c <= 77) return (Number.isFinite(t) && t <= 2) ? 'snow' : 'rain';
  if (c >= 85 && c <= 86) return (Number.isFinite(t) && t <= 2) ? 'snow' : 'rain';
  return 'sunny';
}

/** 高德逆地理编码：经纬度 → 「城市·区·街道」（示例，实际地点由配置决定） */
async function amapRegeo(lat, lon, key) {
  if (!key) return ""
  try {
    const url = "https://restapi.amap.com/v3/geocode/regeo?key=" + encodeURIComponent(key) +
      "&location=" + Number(lon).toFixed(6) + "," + Number(lat).toFixed(6) + "&extensions=base"
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const r = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    const j = await r.json().catch(() => null)
    if (!j || String(j.status) !== "1" || !j.regeocode) return ""
    const c = j.regeocode.addressComponent || {}
    const str = (v) => (typeof v === "string" && v ? v : "")
    const parts = []
    const city = str(c.city) || str(c.province)
    const district = str(c.district)
    const street = str(c.streetNumber && c.streetNumber.street) || str(c.township)
    if (city) parts.push(city.replace(/市$/, ""))
    if (district && district !== city) parts.push(district)
    if (street) parts.push(street)
    return parts.length ? parts.join("·") : str(j.regeocode.formatted_address).slice(0, 40)
  } catch {
    return ""
  }
}

async function locate(lat, lon) {
  // 优先用配置坐标；没有就尝试 IP 定位（容器里 http 可能不通，失败就用默认）
  if (String(lat || '').trim() && String(lon || '').trim() && Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
    return { lat: Number(lat), lon: Number(lon), city: '' };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch('http://ip-api.com/json/?lang=zh-CN', { signal: ctrl.signal });
    clearTimeout(timer);
    const j = await r.json().catch(() => null);
    if (j && j.status === 'success' && Number.isFinite(Number(j.lat))) {
      return { lat: Number(j.lat), lon: Number(j.lon), city: String(j.city || j.regionName || '') };
    }
  } catch {}
  return { lat: DEFAULT_LAT, lon: DEFAULT_LON, city: '北京' };
}

/** 当前天气（30 分钟缓存） */
export async function currentWeather(home = os.homedir(), config = {}) {
  const file = paths(home);
  const cached = readJson(file, null);
  if (cached && Date.now() - Number(cached.at || 0) < CACHE_TTL && cached.kind) return cached;
  const loc = await locate(config.weatherLat, config.weatherLon)
  let placeName = ""
  try { placeName = await amapRegeo(loc.lat, loc.lon, config.weatherAmapKey) } catch {};
  let kind = 'sunny';
  let temp = null;
  let code = null;
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat + '&longitude=' + loc.lon + '&current=temperature_2m,weather_code&timezone=auto';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const j = await r.json().catch(() => null);
    const cur = j && j.current;
    if (cur) {
      temp = Number(cur.temperature_2m);
      code = Number(cur.weather_code);
      kind = mapWeatherCode(code, temp);
    }
  } catch {}
  const out = {
    kind,
    temp: Number.isFinite(temp) ? Math.round(temp * 10) / 10 : null,
    code,
    city: placeName || loc.city || String(config.weatherCity || ''),
    lat: loc.lat,
    lon: loc.lon,
    at: Date.now(),
  };
  writeJson(file, out);
  return out;
}

/** 给提示词用的一句话 */
export function weatherPromptBlock(info) {
  if (!info || !info.kind) return '';
  const label = { sunny: '晴', cloudy: '阴/多云', rain: '下雨', snow: '下雪', storm: '雷雨' }[info.kind] || '晴';
  const t = Number.isFinite(info.temp) ? '，' + info.temp + '℃' : '';
  return '【外面的天气】' + (info.city ? info.city + ' ' : '') + label + t + '。聊天时知道外面是什么天气，可以自然带到（「外面在下雨」「今天好晒」），别提「天气接口」这种词。';
}
