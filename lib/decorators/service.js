'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.Service = Service;

var _moduleContainer = require('../core/moduleContainer');

function Service(target) {
  target.moduleType = 'service';
  _moduleContainer.ModuleContainer.addService(target);
}
//# sourceMappingURL=service.js.map