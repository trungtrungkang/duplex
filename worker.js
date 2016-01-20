var Events = require('./events');
var events = new Events();
var hasOwn = Object.prototype.hasOwnProperty;
var external = {};

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

var internal = (function(){
    var api = {};
    var tokens = {};
    var commands = {
        'register-exports': function(args){
            try{
                var exports = eval(args)[0];
                for(var i in exports){
                    if(hasOwn.call(exports, i)){
                        api[i] = exports[i];
                        //applyAPI(api, i, exports[i]);
                    }
                }
                
                sendRESOnly({cmd: 'register-exports'});
            }catch(ex){
                sendRESOnly({cmd: 'register-exports', args: {error: '[register-exports error]' + ex.toString()}});
            }
        },
        'register-imports': function(args){
            for(var i = 0; i < args.length; i++){
                var name = args[i];
                applyAPI(external, name, this.createAPIMethod(name));
                //external[name] = this.createAPIMethod(name);
                tokens[name] = 0;
            }
            
            sendRESOnly({cmd: 'register-imports'});
        },
        createAPIMethod: function(name){
            var self = this;
            var mname = name;
            return function(){
                var token = ++tokens[name];//abc
                var args = [].slice.call(arguments);
                
                return new Promise(function (resolve, reject) {
                    events.once('invoke-' + mname + '-' + token, function (err, result) {
                        if (err) reject.call(self, err);
                        else resolve.apply(self, result);
                    });

                    sendREQOnly({
                        cmd: 'invoke',
                        args: {
                            name: mname,
                            token: token,
                            args: args
                        }
                    });
                });
            };
        },
        invoke: function(data){
            var token = data.token;
            var name = data.name;
            
            if(data.args == null) data.args = [];
            else if(!(data.args instanceof Array)) data.args = [data.args];
            
            var promise = api[name].apply(api, data.args);
            if(!(promise instanceof Promise)){
                var result = promise;
                promise = new Promise(function(resolve){
                    setTimeout(function(){resolve(result);}, 1);
                });
            }
            
            var cmd = 'invoke-' + name + '-' + token;
            promise.then(function(){
                sendRESOnly({
                    cmd: cmd,
                    args: {
                        result: [].slice.call(arguments)
                    }
                });
            }).catch(function(err){
                sendRESOnly({
                    cmd: cmd,
                    args: {
                        error: '[invoke error]' + err.toString()
                    }
                });
            });
        }
    };
    return {
        set: function(cmd, handler){
            commands[cmd] = handler;
        },
        get: function(cmd){
            return commands[cmd];
        },
        createAPIMethod: commands.createAPIMethod
    };
})();

function sendREQPromise(data){
    var cmd = 'REQ|' + data.cmd,
        args = data.args;
        
    return new Promise((function(resolve, reject){
        events.once(data.cmd, function(err, result){
            if(!err)
                resolve.apply(this, result);
            else
                reject.call(this, err);
        });
        
        postMessage({cmd: cmd, args: args});
    }).bind(this));
}

function sendREQOnly(data){
    var cmd = 'REQ|' + data.cmd,
        args = data.args;
    postMessage({cmd: cmd, args: args});
}

function sendRESOnly(data){
    var cmd = 'RES|' + data.cmd,
        args = data.args;
    postMessage({cmd: cmd, args: args});
}

self.addEventListener('message', function(event){
    var data = event.data;
    var args = data.args;
    var parts = data.cmd.split('|');
    var type = parts[0], cmd = parts[1];
    if(type === 'REQ'){
        if(args == null) args = [];
        else if(!(args instanceof Array)) args = [args];
        
        var handler = internal.get(cmd);
        if(handler) handler.apply(internal, args);
        else this.events.raise(cmd, args);
    }
    else{
        if(args == null) args = {};
        events.emit(cmd, args.error, args.result);
    }
});

sendREQOnly({cmd: 'worker-loaded'});

module.exports = {
    external: external,
    sendREQPromise: sendREQPromise,
    sendREQOnly: sendREQOnly,
    sendRESOnly: sendRESOnly,
    addEventListener: function(type, listener){
        self.addEventListener(type, listener);
    },
    removeEventListener: function(type, listener){
        self.removeEventListener(type, listener);
    }
};