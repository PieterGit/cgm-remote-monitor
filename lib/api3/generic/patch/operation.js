'use strict';

const _ = require('lodash')
  , apiConst = require('../../const.json')
  , security = require('../../security')
  , validate = require('./validate.js')
  , opTools = require('../../shared/operationTools')
  , dateTools = require('../../shared/dateTools')
  , FieldsProjector = require('../../shared/fieldsProjector')
  ;

/**
  * PATCH: Partially updates document in the collection
  */
async function patch (opCtx) {

  const { req, res, col } = opCtx;
  const doc = req.body;

  if (_.isEmpty(doc)) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_REQUEST_BODY);
  }

  await security.demandPermission(opCtx, `api:${col.colName}:update`);
  
  // parseDate is not valid for patch operation
  // (it is adding new fields)
  // col.parseDate(doc);
  const identifier = req.params.identifier
    , identifyingFilter = col.storage.identifyingFilter(identifier);

  const result = await col.storage.findOneFilter(identifyingFilter, { });

  if (!result)
    throw new Error('result empty');

  if (result.length > 0) {

    const storageDoc = result[0];
    if (storageDoc.isValid === false) {
      return opTools.sendJSONStatus(res, apiConst.HTTP.GONE);
    }

    const modifiedDate = col.resolveDates(storageDoc)
      , ifUnmodifiedSince = req.get('If-Unmodified-Since');

    if (ifUnmodifiedSince
      && dateTools.floorSeconds(modifiedDate) > dateTools.floorSeconds(new Date(ifUnmodifiedSince))) {
      return opTools.sendJSONStatus(res, apiConst.HTTP.PRECONDITION_FAILED);
    }

    await applyPatch(opCtx, identifier, doc, storageDoc);
  }
  else {
    return opTools.sendJSONStatus(res, apiConst.HTTP.NOT_FOUND);
  }
}


/**
 * Patch existing document in the collection
 * @param {Object} opCtx
 * @param {string} identifier
 * @param {Object} doc - fields and values to patch
 * @param {Object} storageDoc - original (database) version of document
 */
async function applyPatch (opCtx, identifier, doc, storageDoc) {

  const { ctx, res, col, auth } = opCtx;

  if (validate(opCtx, doc, storageDoc) !== true)
    return;

  const now = new Date;
  doc.srvModified = now.getTime();

  if (auth && auth.subject && auth.subject.name) {
    doc.modifiedBy = auth.subject.name;
  }

  // Normalize time/duration fields to ensure consistency
  // This mirrors the normalization in replace.js to handle cases where
  // AAPS sends partial updates with endmills: null when cutting temp basals
  const times = require('../../../times');
  try {
    // Ensure we have a mills value - check patch, storage, and fallback to date fields
    let baseMills = doc.mills || storageDoc.mills;

    // If mills is missing from both doc and storageDoc, calculate it from date fields
    if (!baseMills) {
      if (Object.prototype.hasOwnProperty.call(doc, 'created_at')) {
        baseMills = new Date(doc.created_at).getTime();
        doc.mills = baseMills;
      } else if (Object.prototype.hasOwnProperty.call(doc, 'date')) {
        baseMills = typeof doc.date === 'number' ? doc.date : new Date(doc.date).getTime();
        doc.mills = baseMills;
      } else if (storageDoc.created_at) {
        baseMills = new Date(storageDoc.created_at).getTime();
        doc.mills = baseMills;
      } else if (storageDoc.date) {
        baseMills = typeof storageDoc.date === 'number' ? storageDoc.date : new Date(storageDoc.date).getTime();
        doc.mills = baseMills;
      }
    } else if (!doc.mills) {
      // Ensure mills is in the patch doc
      doc.mills = baseMills;
    }

    // If endmills is null or missing in patch and we have duration info, recalculate it
    if ((!Object.prototype.hasOwnProperty.call(doc, 'endmills') || doc.endmills == null) && baseMills) {
      if (Object.prototype.hasOwnProperty.call(doc, 'durationInMilliseconds')) {
        const dim = Number(doc.durationInMilliseconds) || 0;
        if (dim > 0) doc.endmills = Number(baseMills) + dim;
      } else if (Object.prototype.hasOwnProperty.call(doc, 'duration')) {
        doc.endmills = Number(baseMills) + times.mins(Number(doc.duration) || 0).msecs;
      } else if (storageDoc.durationInMilliseconds) {
        const dim = Number(storageDoc.durationInMilliseconds) || 0;
        if (dim > 0) doc.endmills = Number(baseMills) + dim;
      } else if (storageDoc.duration) {
        doc.endmills = Number(baseMills) + times.mins(Number(storageDoc.duration) || 0).msecs;
      }
    }

    // Force consistency between mills/endmills and duration fields
    if (baseMills && doc.endmills) {
      const mills = Number(baseMills) || 0;
      const endmills = Number(doc.endmills) || 0;
      if (endmills >= mills) {
        doc.durationInMilliseconds = endmills - mills;
        doc.duration = Math.round((doc.durationInMilliseconds || 0) / 60000);
      }
    }
  } catch (e) {
    // tolerate normalization errors and proceed with patch
  }

  const matchedCount = await col.storage.updateOne(identifier, doc);

  if (!matchedCount)
    throw new Error('matchedCount empty');

  res.setHeader('Last-Modified', now.toUTCString());
  opTools.sendJSONStatus(res, apiConst.HTTP.OK);

  const fieldsProjector = new FieldsProjector('_all');
  const patchedDocs = await col.storage.findOne(identifier, fieldsProjector);
  const patchedDoc = patchedDocs[0];
  fieldsProjector.applyProjection(patchedDoc);
  ctx.bus.emit('storage-socket-update', { colName: col.colName, doc: patchedDoc });

  col.autoPrune();
  ctx.bus.emit('data-received');
}


function patchOperation (ctx, env, app, col) {

  return async function operation (req, res) {

    const opCtx = { app, ctx, env, col, req, res };

    try {
      opCtx.auth = await security.authenticate(opCtx);

      await patch(opCtx);

    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        return opTools.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }
  };
}

module.exports = patchOperation;
