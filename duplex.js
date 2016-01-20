/* global System */
var utils = require('./utils');
var Events = require('./events');
var hasOwn = Object.prototype.hasOwnProperty;

function applyAPI(dest, path, fn){
    var names = path.split('/');
    var last = names[names.length - 1];
    var cur = dest;
    for(var i = 0, len = names.length - 1; i < len; i++){
        var name = names[i];
        var next = cur[name];
        if(!next) next = cur[name] = {};
        cur = next;
    }
    
    cur[last] = fn;
}

function getValue(obj, path){
    var names = path.split('/');
    var last = names[names.length - 1];
    var cur = obj;
    for(var i = 0, len = names.length - 1; i < len; i++){
        var name = names[i];
        cur = obj[name];
        if(cur == null) throw 'obj["'+path+'"] is undefined.';
    }
    
    return cur[last];
}

function visitAllFunctions(src, handler, path){
    for(var i in src){
        if(hasOwn.call(src, i)){
            var val = src[i];
            var t = typeof(val);
            if(t === 'function') handler(path ? path + '/' + i : i, val);
            else if(t === 'object'){
                path = (path) ? (path + '/' + i) : i;
                visitAllFunctions(src[i], handler, path);
            }
        }
    }
}

function DuplexContext(worker, settings) {
    if(!settings) settings = {};
    var self = this;
    this.token = 0;
    this.worker = worker;
    this.events = new Events();
    this.readyCallbacks = [];
    this.api = {};
    this._imports = {};

    worker.readyCallbacks = [];
    worker.ready = function () {
        return new Promise(function (resolve) {
            if (worker.isReady) resolve();
            else worker.readyCallbacks.push(resolve);
        });
    };

    this.events.on('invoke', invoke);
    this.events.once('worker-loaded', onWorkerLoaded);
    worker.addEventListener('message', onmessage);

    function onWorkerLoaded() {
        worker.isReady = true;
        while (worker.readyCallbacks.length) {
            var cb = worker.readyCallbacks.splice(0, 1)[0];
            cb();
        }
    }

    function onmessage(event) {
        var data = event.data;
        var args = data.args;
        var parts = data.cmd.split('|');
        var type = parts[0], cmd = parts[1];
        if (type === 'REQ') {
            if (args == null) args = [];
            else if (!(args instanceof Array)) args = [args];

            self.events.raise(cmd, args);
        }
        else {
            if (args == null) args = {};
            self.events.emit(cmd, args.error, args.result);
        }
    }
    
    function invoke(data){
        var token = data.token;
        var name = data.name;
        
        if(data.args == null) data.args = [];
        else if(!(data.args instanceof Array)) data.args = [data.args];
        
        var promise = self._imports[name].apply(self._imports, data.args);
        if(!(promise instanceof Promise)){
            var result = promise;
            promise = new Promise(function(resolve){
                setTimeout(function(){resolve(result);}, 1);
            });
        }
        
        var cmd = 'invoke-' + name + '-' + token;
        promise.then(function(){
            self.sendRESOnly({
                cmd: cmd,
                args: {
                    result: [].slice.call(arguments)
                }
            });
        }).catch(function(err){
            self.sendRESOnly({
                cmd: cmd,
                args: {
                    error: '[invoke error]' + err.toString()
                }
            });
        });
    }

    if (settings.exports) this.exports(settings.exports);
    if(settings.imports) this.imports(settings.imports);
}

DuplexContext.prototype = {
    ready: function () {
        return new Promise((function (resolve, reject) {
            if (this.isReady) resolve();
            else this.readyCallbacks.push(resolve);
        }).bind(this));
    },
    imports: function (data) {
        var self = this;
        self.worker.ready().then(function(){
            var names = [];
            visitAllFunctions(data, function(name, fn){
                names.push(name);
                self._imports[name] = fn;
            });
            
            return self.sendREQPromise({cmd: 'register-imports', args: [names]});
        });
    },
    exports: function (data) {
        var self = this;
        return new Promise(function(resolve, reject){
            self.isReady = false;
            
            var scriptParts = [];
            visitAllFunctions(data, function(name, fn){
                scriptParts.push("'" + name + "':" + fn.toString());
                applyAPI(self.api, name, self.createAPIMethod(name));
            });
            
            self.worker.ready().then(function(){
                return self.sendREQPromise({ 
                    cmd: 'register-exports', 
                    args: ['[{', scriptParts.join(','), '}]'].join('')
                });
            }).then(function(){
                self.isReady = true;
                while (self.readyCallbacks.length) {
                    var cb = self.readyCallbacks.splice(0, 1)[0];
                    if (cb) cb();
                }
                resolve.apply(self, arguments);
            }).catch(function (err) {
                console.error('[DuplexContext._onready Error]', err);
                reject.apply(self, arguments);
            });
        });
    },
    createAPIMethod: function(name){
        var self = this;
        var mname = name;
        return function(){
            var token = ++self.token;
            var args = [].slice.call(arguments);
            return self.ready().then(function () {
                return new Promise(function (resolve, reject) {
                    self.events.once('invoke-' + mname + '-' + token, function (err, result) {
                        if (err) reject.call(self, err);
                        else resolve.apply(self, result);
                    });

                    self.sendREQOnly({
                        cmd: 'invoke',
                        args: {
                            name: mname,
                            token: token,
                            args: args
                        }
                    });
                });
            });
        };
    },
    sendREQPromise: function (data) {
        var self = this;

        return new Promise(function (resolve, reject) {
            var cmd = 'REQ|' + data.cmd,
                args = data.args;
            self.events.once(data.cmd, function (err, result) {
                if (!err) resolve.apply(self, result);
                else reject.call(self, err);
            });

            self.worker.postMessage({ cmd: cmd, args: args });
        });
    },
    sendREQOnly: function (data) {
        var cmd = 'REQ|' + data.cmd,
            args = data.args;
        this.worker.postMessage({ cmd: cmd, args: args });
    },
    sendRESOnly: function (data) {
        var cmd = 'RES|' + data.cmd,
            args = data.args;
        this.worker.postMessage({ cmd: cmd, args: args });
    }
};

function duplex(settings) {
    var main = settings.main || 'scripts/duplex/worker';
    var worker = new Worker(System.stealURL + '?main=' + main);
    return new DuplexContext(worker, settings);
}

module.exports = duplex;