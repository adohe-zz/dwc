var http = require('http'),
    https = require('https'),
    path = require('path'),
    EventEmitter = require('events').EventEmitter;

var express = require('express'),
    io = require('socket.io'),
    pty = require('pty.js'),
    term = require('term.js');

function Server(conf) {
  if(!(this instanceof Server)) {
    return new Server(conf);
  }

  var self = this;

  this.app = express();
  this.server = conf.https && conf.https.key
    ? https.createServer(conf.https)
    : http.createServer();
  this.server.on('request', this.app);

  this.sessions = {};
  this.conf = conf;
  this.io = io.listen(this.server, conf.io || {
    log: false
  });

  this.on('listening', function() {
    console.log('listening on port 8000');
  });

  this.init();
}

Server.prototype.init = function() {
  this.init = function() {}
  this.initMiddlewares();
  //this.initRoutes();
  this.initIO();
}

/**
 * Init Express middlewares
 */
Server.prototype.initMiddlewares = function() {
  var self = this,
      conf = this.conf;

  this.use(function(req, res, next) {
    var setHeader = res.setHeader;
    res.setHeader = function(name) {
      switch (name) {
        case 'Cache-Control':
        case 'Last-Modified':
        case 'ETag':
          return;
      }
      return setHeader.apply(res, arguments);
    };
    next();
  });

  // Auth
  /*this.use(function(req, res, next) {
    next();
  });*/

  // Return term.js
  this.use(term.middleware());

  this.use(express.favicon(__dirname + '/../static/favicon.ico'));

  this.use(this.app.router);

  this.use(express.static(__dirname + '/../static'));
}

/**
 * Init additional routes
 */
Server.prototype.initRoutes = function() {
  var self = this;
}

/**
 * Init Socket.io
 */
Server.prototype.initIO = function() {
  var self = this,
      io = this.io;

  io.configure(function() {
    io.disable('log');
  });

  /*io.set('authorization', function(data, next) {
    return self.handleAuth(data, next);
  });*/

  io.sockets.on('connection', function(socket) {
    return self.handleConnection(socket);
  });
}

/**
 * Auth
 */
Server.prototype.handleAuth = function(data, next) {
}

/**
 * Connection Hanlding
 */
Server.prototype.handleConnection = function(socket) {
  var session = new Session(this, socket);

  socket.on('create', function(cols, rows, command, commandArgs, func) {
    return session.handleCreate(cols, rows, command, commandArgs, func);
  });

  socket.on('data', function(id, data) {
    return session.handleData(id, data);
  });

  socket.on('kill', function(id) {
    return session.handleKill(id);
  });

  socket.on('process', function(id, func) {
  });

  socket.on('disconnect', function() {
  });
}

Server.prototype.listen = function(port, hostname, func) {
  port = port || this.conf.port || 8080;
  hostname = hostname || this.conf.hostname;
  return this.server.listen(port, hostname, func);
}

Server.prototype.log = function(msg) {
}


/**
 * Session
 */
function Session(server, socket) {
  if(!(this instanceof Session)) {
    return Session(server, socket);
  }

  this.server = server;
  this.socket = socket;
  this.terms = {};
  this.req = socket.handshake;

  var conf = this.server.conf,
      terms = this.terms,
      sessions = this.server.sessions,
      req = socket.handshake;

  this.user = req.user;
  this.id = req.user || this.uid();

  sessions[this.id] = this;

  //this.log('Session \x1b[1m%s\x1b[m created.', this.id);
  console.log('Session ' + this.id + ' created');
}

Session.uid = 0;
Session.prototype.uid = function() {
  return Session.uid++ + '';
}

Session.prototype.disconnect = function() {
}

/**
 * Terminal creation handling
 */
Session.prototype.handleCreate = function(cols, rows, command, commandArgs, func) {
  var self = this,
      terms = this.terms,
      conf = this.server.conf,
      socket = this.socket;

  var len = Object.keys(terms).length,
      term,
      id;

  if(len > conf.limitPerUser || pty.total >= conf.limitGlobal) {
    return func({ error: 'Terminal limit.' });
  }

  if(typeof command !== 'string') {
    return func({ error: 'Command must be a string' });
  }
  var shell = command;
  if(Object.prototype.toString.call(commandArgs) !== '[object Array]') {
    return func({ error: 'Command Args must be an array'});
  }
  var shellArgs = commandArgs;

  term = pty.fork(shell, shellArgs, {
    name: conf.termName,
    cols: cols,
    rows: rows,
    cwd: conf.cwd || process.env.HOME
  });

  id = term.pty;
  terms[id] = term;

  term.on('data', function(data) {
    self.socket.emit('data', id, data);
  });

  term.on('close', function() {
    // Make sure it closes
    // on the clientside
    self.socket.emit('kill', id);

    // Ensure removal
    if(terms[id]) delete terms[id];

    /*self.log(
      'Closed pty (%s): %d.',
      term.pty, term.fd);*/
  });


  /*this.log(
    'Created pty (id: %s, master: %d, pid: %d).',
    id, term.fd, term.pid);*/

  return func(null, {
    id: id,
    pty: term.pty,
    process: sanitize(shell)
  });
}

/**
 * Terminal data handling
 */
Session.prototype.handleData = function(id, data) {
  var terms = this.terms;
  if(!terms[id]) {
    // TODO: print waring
    return;
  }
  terms[id].write(data);
}

/**
 * Terminal kill handling
 */
Session.prototype.handleKill = function(id) {
  var terms = this.terms;
  if(!terms[id]) return;
  terms[id].destroy();
  delete terms[id];
}

/**
 * "Inherit" Express Methods
 */

// Methods
Object.keys(express.application).forEach(function(key) {
  if(Server.prototype[key]) return;
  Server.prototype[key] = function() {
    return this.app[key].apply(this.app, arguments);
  };
});

// Middleware
Object.getOwnPropertyNames(express).forEach(function(key) {
  var prop = Object.getOwnPropertyDescriptor(express, key);
  if(typeof prop.get !== 'function') return;
  Object.defineProperty(Server, key, prop);
});

// Server Methods
Object.keys(EventEmitter.prototype).forEach(function(key) {
  if(Server.prototype[key]) return;
  Server.prototype[key] = function() {
    return this.server[key].apply(this.server, arguments);
  };
});

function sanitize(file) {
  if (!file) return '';
  file = file.split(' ')[0] || '';
  return path.basename(file) || '';
}

/**
 * Expose
 */

exports = Server;
exports.createServer = Server;

module.exports = exports;
