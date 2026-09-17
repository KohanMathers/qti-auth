export interface Device {
  browser: string;
  os: string;
}

export function parseDevice(userAgent: string | null): Device {
  if (userAgent === null || userAgent.trim() === '') {
    return { browser: 'an unknown browser', os: 'an unknown OS' };
  }
  return { browser: browserOf(userAgent), os: osOf(userAgent) };
}

export function deviceKey(device: Device): string {
  return `${device.browser}|${device.os}`;
}

export function countryName(code: string | null): string | null {
  if (code === null) return null;
  try {
    return new Intl.DisplayNames(['en-GB'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function describePlace(country: string | null): string {
  const name = countryName(country);
  if (name === null) return 'from an unknown location';
  return `in ${name}`;
}

function browserOf(ua: string): string {
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('OPR/') || ua.includes('Opera/')) return 'Opera';
  if (ua.includes('Chrome/') || ua.includes('CriOS/')) return 'Chrome';
  if (ua.includes('Firefox/') || ua.includes('FxiOS/')) return 'Firefox';
  if (ua.includes('Safari/') && ua.includes('Version/')) return 'Safari';
  return 'an unknown browser';
}

function osOf(ua: string): string {
  if (ua.includes('Android')) return 'Android';
  if (ua.includes('iPhone') || ua.includes('iPad') || ua.includes('iPod')) return 'iOS';
  if (ua.includes('Windows NT')) return 'Windows';
  if (ua.includes('Mac OS X')) return 'macOS';
  if (ua.includes('Linux')) return 'Linux';
  return 'an unknown OS';
}
