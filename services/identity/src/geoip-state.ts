import type { GeoIp } from '@qtiauth/geoip';

import { contextAttachment } from './attachments.ts';

const attachment = contextAttachment<GeoIp>();

export const attachGeoIp = attachment.attach;
export const geoIpOf = attachment.of;
