'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PRODUCT = 'internetsosplay';

function getPublicKeyPath() {
  return path.join(__dirname, 'license-public.pem');
}

function loadPublicKey() {
  const p = getPublicKeyPath();
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

/** Misma cadena que usa tools/generate-license.js */
function signMessage(payload) {
  const email = payload.email != null ? String(payload.email) : '';
  return `${payload.deviceId}|${payload.product}|${payload.issuedAt}|${email}`;
}

function normalizePayload(obj) {
  return {
    deviceId: String(obj.deviceId || ''),
    product: String(obj.product || ''),
    issuedAt: String(obj.issuedAt || ''),
    email: obj.email != null ? String(obj.email) : ''
  };
}

function verifyLicenseObject(obj, publicKeyPem) {
  if (!obj || !obj.signature) return { ok: false, error: 'Falta firma' };
  let signature;
  try {
    signature = Buffer.from(obj.signature, 'base64');
  } catch {
    return { ok: false, error: 'Firma invalida' };
  }
  const payload = normalizePayload(obj);
  if (payload.product !== PRODUCT) return { ok: false, error: 'Producto invalido' };
  const msg = signMessage(payload);
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    const ok = crypto.verify(null, Buffer.from(msg, 'utf8'), key, signature);
    return ok ? { ok: true, payload } : { ok: false, error: 'Firma invalida' };
  } catch (e) {
    return { ok: false, error: e.message || 'Error verificando firma' };
  }
}

function verifyForDevice(currentDeviceId, obj, publicKeyPem) {
  const r = verifyLicenseObject(obj, publicKeyPem);
  if (!r.ok) return r;
  if (r.payload.deviceId !== currentDeviceId) {
    return { ok: false, error: 'Licencia no corresponde a este equipo' };
  }
  return r;
}

function getDeviceId() {
  const { machineIdSync } = require('node-machine-id');
  return machineIdSync();
}

function readLicenseFile(licensePath) {
  if (!fs.existsSync(licensePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(licensePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} licenseDir userData
 */
function isLicenseValid(licenseDir) {
  const publicKey = loadPublicKey();
  if (!publicKey) {
    return { valid: false, error: 'Falta lib/license-public.pem en la app', deviceId: '' };
  }
  let deviceId;
  try {
    deviceId = getDeviceId();
  } catch (e) {
    return { valid: false, error: 'No se pudo leer ID de equipo', deviceId: '' };
  }
  const licensePath = path.join(licenseDir, 'license.json');
  const obj = readLicenseFile(licensePath);
  if (!obj) return { valid: false, error: 'Sin licencia activa', deviceId };
  const v = verifyForDevice(deviceId, obj, publicKey);
  return v.ok ? { valid: true, payload: v.payload, deviceId } : { valid: false, error: v.error, deviceId };
}

function parseLicenseText(text) {
  if (!text || typeof text !== 'string') return { ok: false, error: 'Vacío' };
  const trimmed = text.trim();
  try {
    return { ok: true, obj: JSON.parse(trimmed) };
  } catch {
    return { ok: false, error: 'JSON invalido' };
  }
}

module.exports = {
  PRODUCT,
  signMessage,
  loadPublicKey,
  getPublicKeyPath,
  getDeviceId,
  isLicenseValid,
  verifyForDevice,
  parseLicenseText
};
