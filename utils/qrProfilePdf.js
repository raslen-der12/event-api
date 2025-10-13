const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');

/**
 * Creates a PDF Buffer with a QR code that opens the public profile.
 * @param {Object} opts
 * @param {String} opts.publicUrl - e.g. `${FRONTEND_URL}/public/${role}/${actorId}`
 * @param {Object} opts.header - { title, subtitle }
 * @param {Object} opts.fields - key-value pairs to render (email, role, name, etc.)
 * @returns {Promise<Buffer>}
 */
async function makeQrPdf({ publicUrl, header={}, fields={} }){
  const doc = new PDFDocument({ size:'A4', margin: 50 });
  const chunks = [];
  doc.on('data', d => chunks.push(d));
  const done = new Promise(res => doc.on('end', ()=>res(Buffer.concat(chunks))));

  doc.fontSize(20).text(header.title || 'GITS Profile', { align:'left' });
  doc.moveDown(0.5);
  doc.fontSize(12).text(header.subtitle || 'Scan to view public profile');

  const qrDataUrl = await QRCode.toDataURL(publicUrl, { width: 256, margin:1 });
  const base64 = qrDataUrl.split(',')[1];
  const qrBuf = Buffer.from(base64, 'base64');

  doc.image(qrBuf, { fit:[180,180], align:'left' }).moveDown(1);

  doc.fontSize(12);
  Object.entries(fields).forEach(([k,v])=>{
    doc.text(`${k}: ${v}`);
  });

  doc.moveDown(1);
  doc.text(publicUrl, { link: publicUrl, underline:true });

  doc.end();
  return done;
}

module.exports = { makeQrPdf };
