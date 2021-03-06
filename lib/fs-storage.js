module.exports = FSStorage

var dezalgo = require('dezalgo')
var fs = require('fs')
var inherits = require('inherits')
var mkdirp = require('mkdirp')
var os = require('os')
var path = require('path')
var raf = require('random-access-file')
var rimraf = require('rimraf')
var Storage = require('./storage')
var thunky = require('thunky')

var TMP = path.join(fs.existsSync('/tmp') ? '/tmp' : os.tmpDir(), 'webtorrent')

inherits(FSStorage, Storage)

/**
 * fs-backed Storage for a torrent download.
 *
 * @param {Object} parsedTorrent
 * @param {Object} opts
 */
function FSStorage (parsedTorrent, opts) {
  var self = this

  self.tmp = opts.tmp || TMP
  self.path = opts.path || path.join(self.tmp, parsedTorrent.infoHash)

  self.piecesMap = []
  self.nonExistentError = new Error('Cannot read from non-existent file')

  opts.nobuffer = true
  Storage.call(self, parsedTorrent, opts)

  self.files.forEach(function (file) {
    var fileStart = file.offset
    var fileEnd = fileStart + file.length

    var pieceLength = file.pieceLength
    var filePath = path.join(self.path, file.path)

    var openWrite = thunky(function (cb) {
      var fileDir = path.dirname(filePath)

      mkdirp(fileDir, function (err) {
        if (err) return cb(err)
        if (self.closed) return cb(new Error('Storage closed'))

        var fd = raf(filePath)
        file.fd = fd
        cb(null, fd)
      })
    })

    var openRead = thunky(function (cb) {
      // TODO: no need for fs.exists call, just try opening and handle error.
      //       fs.exists then open creates opportunity for race condition.
      fs.exists(filePath, function (exists) {
        if (exists) return openWrite(cb)
        cb(self.nonExistentError)
      })
    })

    file.pieces.forEach(function (piece) {
      var index = piece.index

      var pieceStart = index * pieceLength
      var pieceEnd = pieceStart + piece.length

      var from = (fileStart < pieceStart) ? 0 : fileStart - pieceStart
      var to = (fileEnd > pieceEnd) ? pieceLength : fileEnd - pieceStart
      var offset = (fileStart > pieceStart) ? 0 : pieceStart - fileStart

      if (!self.piecesMap[index]) self.piecesMap[index] = []

      self.piecesMap[index].push({
        from: from,
        to: to,
        offset: offset,
        openWrite: openWrite,
        openRead: openRead
      })
    })
  })
}

FSStorage.prototype.readBlock = function (index, offset, length, cb) {
  var self = this
  cb = dezalgo(cb)
  var piece = self.pieces[index]
  if (!piece) return cb(new Error('invalid piece index ' + index))

  if (piece.verified && piece.buffer) {
    // piece is verified and cached in memory, so read directly from its buffer
    // instead of reading from the filesystem.
    return piece.readBlock(offset, length, cb)
  }

  var rangeFrom = offset
  var rangeTo = rangeFrom + length

  var targets = self.piecesMap[index].filter(function (target) {
    return (target.to > rangeFrom && target.from < rangeTo)
  })

  if (!targets.length) return cb(new Error('no file matching the requested range?'))

  var buffers = []
  var end = targets.length
  var i = 0

  function readFromNextFile (err, buffer) {
    if (err) return cb(err)
    if (buffer) buffers.push(buffer)
    if (i >= end) return cb(null, Buffer.concat(buffers))

    var target = targets[i++]

    var from = target.from
    var to = target.to
    var offset = target.offset

    if (to > rangeTo) to = rangeTo
    if (from < rangeFrom) {
      offset += (rangeFrom - from)
      from = rangeFrom
    }

    target.openRead(function (err, file) {
      if (self.closed) return
      if (err) {
        return err === self.nonExistentError
          ? readFromNextFile(null, new Buffer(0))
          : cb(err)
      }
      file.read(offset, to - from, readFromNextFile)
    })
  }

  readFromNextFile()
}

// flush pieces to file once they're done and verified
FSStorage.prototype._onPieceDone = function (piece) {
  var self = this
  var targets = self.piecesMap[piece.index]
  var end = targets.length
  var i = 0

  function done () {
    Storage.prototype._onPieceDone.call(self, piece)
  }

  if (!piece.buffer || self.readonly) return done()

  function writeToNextFile (err) {
    if (err) return self.emit('error', err)
    if (i >= end) {
      // piece.buffer = null // TODO: free this memory!
      return done()
    }

    var target = targets[i++]
    target.openWrite(function (err, file) {
      if (self.closed) return
      if (err) return self.emit('error', err)
      file.write(target.offset, piece.buffer.slice(target.from, target.to), writeToNextFile)
    })
  }

  writeToNextFile()
}

/**
 * Removes and cleans up any backing store for this storage.
 */
FSStorage.prototype.remove = function (cb) {
  var self = this
  if (!cb) cb = function () {}

  self.close(function (err) {
    if (err) return cb(err)
    var root = self.files[0].path.split(path.sep)[0]
    rimraf(path.join(self.path, root), cb)
  })
}

/**
 * Closes the backing store for this storage.
 */
FSStorage.prototype.close = function (cb) {
  var self = this
  if (!cb) cb = function () {}
  if (self.closed) return cb()

  Storage.prototype.close.call(self, function (err) {
    if (err) return cb(err)

    var i = 0
    function loop (err) {
      if (i >= self.files.length) return cb()
      if (err) return cb(err)
      var next = self.files[i++]
      if (!next || !next.fd) return process.nextTick(loop)
      next.fd.close(loop)
    }

    process.nextTick(loop)
  })
}
