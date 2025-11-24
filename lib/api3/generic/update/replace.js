'use strict';

const apiConst = require('../../const.json')
  , security = require('../../security')
  , validate = require('./validate.js')
  , path = require('path')
  , opTools = require('../../shared/operationTools')
  ;
const times = require('../../../times');

/**
 * Replace existing document in the collection
 * @param {Object} opCtx
 * @param {any} doc - new version of document to set
 * @param {any} storageDoc - old version of document (existing in the storage)
 * @param {Object} options
 */
async function replace (opCtx, doc, storageDoc, options) {

  const { ctx, auth, col, req, res } = opCtx;
  const { isDeduplication } = options || {};

  await security.demandPermission(opCtx, `api:${col.colName}:update`);

  if (validate(opCtx, doc, storageDoc, { isDeduplication }) !== true)
    return;

  const now = new Date;
  doc.srvModified = now.getTime();
  doc.srvCreated = storageDoc.srvCreated || doc.srvModified;

  if (auth && auth.subject && auth.subject.name) {
    doc.subject = auth.subject.name;
  }

  // Ensure time/duration fields exist so a full-document replace doesn't
  // accidentally remove `endmills` or related derived fields. This mirrors
  // runtime normalization in `lib/data/ddata.js` but persists the values
  // on replace operations handled by the API v3 replace endpoint.
  try {
    if (!Object.prototype.hasOwnProperty.call(doc, 'mills')) {
      if (Object.prototype.hasOwnProperty.call(doc, 'created_at')) {
        doc.mills = new Date(doc.created_at).getTime();
      } else if (Object.prototype.hasOwnProperty.call(doc, 'date')) {
        if (typeof doc.date === 'number') doc.mills = doc.date; else doc.mills = new Date(doc.date).getTime();
      }
    }

    if ((!Object.prototype.hasOwnProperty.call(doc, 'endmills') || doc.endmills == null) && Object.prototype.hasOwnProperty.call(doc, 'mills')) {
      if (Object.prototype.hasOwnProperty.call(doc, 'durationInMilliseconds')) {
        const dim = Number(doc.durationInMilliseconds) || 0;
        if (dim > 0) doc.endmills = Number(doc.mills) + dim;
      } else if (Object.prototype.hasOwnProperty.call(doc, 'duration')) {
        doc.endmills = Number(doc.mills) + times.mins(Number(doc.duration) || 0).msecs;
      }
    }

    if (Object.prototype.hasOwnProperty.call(doc, 'mills') && Object.prototype.hasOwnProperty.call(doc, 'endmills')) {
      const mills = Number(doc.mills) || 0;
      const endmills = Number(doc.endmills) || 0;
      if (endmills >= mills) {
        doc.durationInMilliseconds = endmills - mills;
        doc.duration = Math.round((doc.durationInMilliseconds || 0) / 60000);
      }
    }
  } catch (e) {
    // tolerate normalization errors and proceed with replace
  }

  const matchedCount = await col.storage.replaceOne(storageDoc.identifier, doc);

  if (!matchedCount)
    throw new Error('empty matchedCount');

  res.setHeader('Last-Modified', now.toUTCString());
  const fields = {
    lastModified: now.getTime()
  }

  if (storageDoc.identifier !== doc.identifier || isDeduplication) {
    res.setHeader('Location', path.posix.join(req.baseUrl, req.path, doc.identifier));
    fields.identifier = doc.identifier;
    fields.isDeduplication = true;
    if (storageDoc.identifier !== doc.identifier) {
      fields.deduplicatedIdentifier = storageDoc.identifier;
    }
  }

  opTools.sendJSON({ res, status: apiConst.HTTP.OK, fields });

  ctx.bus.emit('storage-socket-update', { colName: col.colName, doc });
  col.autoPrune();
  ctx.bus.emit('data-received');
}


module.exports = replace;
