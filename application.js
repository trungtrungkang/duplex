var Events = require('./events');
var utils = require('./utils');

var bus = new Events();
var components = {};

var services = {
    bus: bus
};

function Sandbox(app){
}
Sandbox.prototype = {
    get: function(name){
        return services[name];
    }
};

var app = {
    register: function (moduleId, creator) {
        components[moduleId] = {
            creator: creator,
            instance: null
        };
    },
    start: function (moduleId) {
        var moduleItem = components[moduleId];
        var instance = moduleItem.creator(new Sandbox(this));
        moduleItem.instance = instance;
        if (instance.init)
            instance.init();
    },
    stop: function (moduleId) {
        var moduleItem = components[moduleId];
        if (moduleItem.instance) {
            var instance = moduleItem.instance;
            moduleItem.instance = null;
            instance.destroy();
        }
    },
    startAll: function () {
        for (var moduleId in components) {
            if (components.hasOwnProperty(moduleId))
                this.start(moduleId);
        }
    },
    stopAll: function () {
        for (var moduleId in components) {
            if (components.hasOwnProperty(moduleId))
                this.stop(moduleId);
        }
    },
    services:{
        set: function(name, service){
            service[name] = service;
        },
        get: function(name){
            return services[name];
        }
    }
};

module.exports = app;