'use strict';

const {ProcessModelService} = require('./dist/commonjs/index');

function registerInContainer(container) {
  container
    .register('ProcessModelService', ProcessModelService)
    .dependencies('BpmnModelParser', 'IamService', 'ProcessDefinitionRepository')
    .singleton();
}

module.exports.registerInContainer = registerInContainer;
