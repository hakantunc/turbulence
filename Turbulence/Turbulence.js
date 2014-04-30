define(['plugin/PluginConfig','plugin/PluginBase','util/assert'],function(PluginConfig,PluginBase,assert) {

  var TurbulencePlugin = function () {
    // Call base class's constructor
    PluginBase.call(this);
  };

  //basic functions and setting for plugin inheritance
  TurbulencePlugin.prototype = Object.create(PluginBase.prototype);
  TurbulencePlugin.prototype.constructor = TurbulencePlugin;
  TurbulencePlugin.prototype.getName = function () {
    return "Turbulence Plugin";
  };
  //use this function to find out if some node is a subtype of the given type
  TurbulencePlugin.prototype._isTypeOf = function(node,type){
    //now we make the check based upon path
    if(node === undefined || node === null || type === undefined || type === null){
      return false;
    }
    var self = this;
    while(node){
      if(self.core.getPath(node) === self.core.getPath(type)){
        return true;
      }
      node = self.core.getBase(node);
    }
    return false;
  };

  //this function loads the children of your workflow allowing your plugin to run synchronously
  TurbulencePlugin.prototype._loadNodes = function(callback){
    //we load the whole subtree of the active node
    var self = this;
    self._nodeCache = {};
    var load = function(node, fn){
      self.core.loadChildren(node,function(err,children){
        if(err){
          fn(err)
        } else {
          var recCalls = children.length,
            error = null; //error

          if(recCalls === 0){
            fn(null);
          }

          for(var i=0;i<children.length;i++){
            self._nodeCache[self.core.getPath(children[i])] = children[i];
            load(children[i], function(err){
              error = error || err;
              if(--recCalls === 0){//callback only on last child
                fn(error);
              }
            });
          }
        }
      });
    };

    load(self.activeNode, callback);
  };

  //This is the main function which is executed when plugin 'button' is clicked
  TurbulencePlugin.prototype.main = function(callback){
    var self = this;
    //checkings
    if(!self.activeNode || !self._isTypeOf(self.activeNode,self.META['Workflow'])){
      //maybe put a proper message in the result
      self._errorMessages('The current worksheet is not valid');
      self.result.setSuccess(false);
      callback(null,self.result);
    } else {
      //we should load the nodes
      self._loadNodes(function(err){
        if(err){
          self.result.setSuccess(false);
          callback(err,self.result);
        } else {
          //now here starts the real plugin work
          self._execute(function(){
            callback(null,self.result);
          });
        }
      });
    }
  };


  TurbulencePlugin.prototype._execute = function(callback) {
    var self = this,
      name_of_the_project = self.core.getAttribute(self.activeNode, 'name'),
      childrenIds = self.core.getChildrenPaths(self.activeNode),
      primitives = [],
      dynamicPrimitives = [],
      procs = {},
      flows = [],
      i, j;

    // go through each child of the workflow and populte 4 types of children
    for (i = 0; i < childrenIds.length; i++) {

      var child = self._nodeCache[childrenIds[i]];
      var base_id = self.core.getPath(self.core.getBase(child));

      if ( base_id === self.core.getPath(self.META['Primitive_Parameter']) ) {
        primitives.push(childrenIds[i]);

      } else if ( base_id === self.core.getPath(self.META['Buffer']) ) {
        dynamicPrimitives.push(childrenIds[i]);
      
      } else if ( base_id === self.core.getPath(self.META['Proc']) ) {
        
        var proc_node = self._nodeCache[childrenIds[i]];
        var ports_of_proc = self.core.getChildrenPaths(proc_node);
        var inputs = {};
        
        for (j = 0; j < ports_of_proc.length; j++) {
          var port_base = self.core.getPath(self.core.getBase(self._nodeCache[ports_of_proc[j]]));
          if ( port_base === self.core.getPath(self.META['Parameter_Input']) || port_base === self.core.getPath(self.META['Signal_Input']) ) {
            inputs[ports_of_proc[j]] = false;
          }
        }
        procs[childrenIds[i]] = { processed: false, processable: false, inputs: inputs};

      } else {
        if (self.core.getPath(self.core.getBase(self.core.getBase(child))) ) {
          flows.push(childrenIds[i]);
        }
      }

    }

    self.logger.warn('define primitives');
    var primitive_definitions = self._definePrimitives(primitives);

    self.logger.warn('define buffers');
    var dynamic_definitions = self._defineDynamicPrimitives(dynamicPrimitives);

    // dynamic_definitions.forEach(function(definition) {
    //   console.log(definition);
    // });

    self.logger.warn('define procs');
    var proc_definitions = self._defineProcs(procs, flows);

    self.logger.warn('Script generation');
    if (proc_definitions === null) {
        self.result.setSuccess(false);
        return callback(null);
    }

    var pre_script = '//    Copyright 2011 Johns Hopkins University\n//\n//  Licensed under the Apache License, Version 2.0 (the "License");\n//  you may not use this file except in compliance with the License.\n//  You may obtain a copy of the License at\n//\n//      http://www.apache.org/licenses/LICENSE-2.0\n//\n//  Unless required by applicable law or agreed to in writing, software\n//  distributed under the License is distributed on an "AS IS" BASIS,\n//  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.\n//  See the License for the specific language governing permissions and\n//  limitations under the License.\n\n\n#include <stdio.h>\n#include <float.h>\n#include <math.h>\n#include "turblib.h"\n#include "spline_interp_lib.h"\n\nint main(int argc, char *argv[])\n{\n';
    var after_variables = '\n    /* Initialize gSOAP */\n    soapinit();\n    /* Enable exit on error.  See README for details. */\n    turblibSetExitOnError(1);\n';
    var post_script = '/* Free gSOAP resources */\n    soapdestroy();\n\n    return 0;\n}\n\n';

    var full_script = pre_script;

    full_script += '\n //Primitive Definitions\n';
    primitive_definitions.forEach(function(definition) {
      full_script += '    ' + definition + '\n';
    });

    full_script += '\n //Buffer Definitions\n';
    dynamic_definitions.forEach(function(definition) {
      full_script += '    ' + definition['def'] + '\n';
    });

    full_script += after_variables;

    full_script += '\n //Proc Definitions\n';
    proc_definitions.forEach(function(definition) {
      full_script += '    ' + definition + '\n';
    });

    full_script += '\n //Free Buffers\n';
    dynamic_definitions.forEach(function(definition) {
      if (definition['name'] != '' )
        full_script += '    free(' + definition['name'] + ');\n';
    });

    full_script += post_script;

    self._saveOutput(name_of_the_project+'.c',full_script,function(err){
      if(err){
        self.result.error = err;
        self.result.setSuccess(false);
      } else {
        self.result.setSuccess(true);
      }

      callback();
    });
  };

  TurbulencePlugin.prototype._definePrimitives = function(list) {
    var self = this;
    var definitions = [];

    list.forEach(function(element_id) {

      var node = self._nodeCache[element_id];
      var type = self.core.getAttribute(node,'type');
      var size = self.core.getAttribute(node,'size');
      var name = self.core.getAttribute(node,'name');
      var value = self.core.getAttribute(node,'value');
      var pointer = self.core.getAttribute(node,'pointer');
      var def = type;

      if (pointer == true) def += '*';
      if (size > 1) def += '[' + size + ']';
      
      def += ' ' + name;
      
      if (size == 1) {
        if (value != '' ) def += ' = ' + value;
      }
      def += ';';

      definitions.push(def);

      if (size > 1) {
        var values = value.split(',');
        for (var i = 0; i < values.length; i++) {
          var assignment = name + '[' + i + ']' + ' = ' + values[i] + ';';
          definitions.push(assignment);
        }
      }

    });

    return definitions;
  };

  TurbulencePlugin.prototype._defineDynamicPrimitives = function(list) {
    var self = this,
      definitions = [];
    try {
      list.forEach(function(element_id) {
        var node = self._nodeCache[element_id],
          type = self.core.getAttribute(node,'type'),
          size = self.core.getAttribute(node,'size'),
          name = self.core.getAttribute(node,'name'),
          isPointer = self.core.getAttribute(node,'pointer');


        if (isPointer) {
          var childrenIds = self.core.getChildrenPaths(node),
            child_node = self._nodeCache[childrenIds[0]];

          // child type should be int -> check
          var def = type + '* ' + name + ' = (' + type + '*)malloc(sizeof(' + type + ')*';
          if (child_node != null) {
            var ref_name = self.core.getAttribute(self._nodeCache[self.core.getPointerPath(child_node,'ref')],'name');
            def += ref_name + '*';
          }
          def += size + ');';
          definitions.push({name: name, def: def});
        } else {
          def = self._definePrimitives([element_id]);
          definitions.push({name: '', def: def});
        }

      });
    } catch(e) {
      self.logger.error(e);
    }
    return definitions;
  };


  ////

  TurbulencePlugin.prototype._saveOutput = function(fileName,stringFileContent,callback){
    var self = this,
      artifact = self.blobClient.createArtifact(self.projectName+"_Turbulence_Output");

    artifact.addFile(fileName,stringFileContent,function(err){
      if(err){
        callback(err);
      } else {
        self.blobClient.saveAllArtifacts(function(err, hashes) {
          if (err) {
            callback(err);
          } else {
            self.logger.info('Artifacts are saved here:');
            self.logger.info(hashes);

            // result add hashes
            for (var j = 0; j < hashes.length; j += 1) {
              self.result.addArtifact(hashes[j]);
            }

            self.result.setSuccess(true);
            callback(null);
          }
        });
      }
    });
  };

  TurbulencePlugin.prototype._errorMessages = function(message){
    //TODO the erroneous node should be send to the function
    var self = this;
    self.createMessage(self.activeNode,message);
  };


  TurbulencePlugin.prototype._defineProcs = function(procs, flows) {
    var self = this;
    var definitions = [];

    //check procs that do not have any input ports
    for (var key in procs) {
      var childrenIds = self.core.getChildrenPaths(self._nodeCache[key]);
      procs[key]['processable'] = true;
      for (var i = childrenIds.length - 1; i >= 0; i--) {
        var child = self._nodeCache[childrenIds[i]];
        var base_id = self.core.getPath(self.core.getBase(child));
        var comp = self.core.getPath(self.META['Parameter_Input']);
        if (base_id == comp) {
          procs[key]['processable'] = false;
        }
        comp = self.core.getPath(self.META['Signal_Input']);
        if (base_id == comp) {
          procs[key]['processable'] = false;
        }

      }
    }

    //go over for all procs
    while (!isAllProcessed(procs)) {
      for (var j = 0; j < flows.length; j++) {
        var flow_node = self._nodeCache[flows[j]],
          src = self.core.getPointerPath(flow_node,'src'),
          dst = self.core.getPointerPath(flow_node,'dst'),
          src_node = self._nodeCache[src],
          dst_node = self._nodeCache[dst];
        if (!doTheTypesMatch(src_node, dst_node, 'type')) {
          errorTypesDoNotMatch(src_node, dst_node, 'type');
          return null;
        }
        if(!doTheTypesMatch(src_node, dst_node, 'pointer')) {
          errorTypesDoNotMatch(src_node, dst_node, 'pointer');
          return null;
        }
        if (isSignalValid(src)) {
          var dest_proc = self.core.getPath(self.core.getParent(dst_node));
          procs[dest_proc]['inputs'][dst] = src;
          procs[dest_proc]['processable'] = true;
          for (var key in procs[dest_proc]['inputs']) {
            if (procs[dest_proc]['inputs'][key] == false)
              procs[dest_proc]['processable'] = false;
          }
        }
      }
      var isProcessed = false;
      for (var key in procs) {
        if (procs[key]['processed'])
          continue;
        if (procs[key]['processable']) {
          //printf
          // var key_node = self._client.getNode(key);
          // console.log('being processed ' + key_node.getAttribute('name'));
          var proc_definition = self._defineProc(key, procs);
          if (proc_definition == null) return null;
          definitions.push(proc_definition);

          procs[key]['processed'] = true;
          isProcessed = true;
        }
      }
      if (!isProcessed)
        break;
    }

    if (Object.keys(procs).length != definitions.length) {
      self._errorMessages("There's a problem with a proc definition");
      return null;
    }

    return definitions;

    function errorTypesDoNotMatch(src_node, dst_node, attr) {
      var src_parent = self.core.getParent(src_node);
      var dst_parent = self.core.getParent(dst_node);
      self._errorMessages('Flow ' + attr +' do not match: '
          + '[' + self.core.getAttribute(src_parent, 'name') + ']:'
          + self.core.getAttribute(src_node,'name') + '('
          + self.core.getAttribute(src_node, attr) + ')'
          + ' -> '
          + '[' + self.core.getAttribute(dst_parent, 'name') + ']:'
          + self.core.getAttribute(dst_node,'name') + '('
          + self.core.getAttribute(dst_node, attr) + ')'

      );
    }

    function doTheTypesMatch(src, dst, attr) {
      if (self.core.getAttribute(src, attr) !== self.core.getAttribute(dst, attr))
        return false;
      return true;
    }

    function isSignalValid(node_id) {
      var node = self._nodeCache[node_id];
      var base_id = self.core.getPath(self.core.getBase(node));
      if (base_id === self.core.getPath(self.META['Primitive_Parameter']) || base_id === self.core.getPath(self.META['Buffer']))
        return true;
      if (base_id === self.core.getPath(self.META['Output'])) {
        var parent_id = self.core.getPath(self.core.getParent(node));
        if (procs[parent_id]['processed'])
          return true;
      }
      return false;
    }

    function isAllProcessed(procs) {
      for (var key in procs) {
        if (!procs[key]['processed'])
          return false;
      }
      return true;
    }

  };

  TurbulencePlugin.prototype._defineProc = function(node_id, procs) {
    var self = this,
      node = self._nodeCache[node_id],
      childrenIds = self.core.getChildrenPaths(node),
      inputs = [],
      inputsRegular = [],
      orderingFlows = [],
      bufferFlows = [];

    childrenIds.forEach(function(child_id) {
      var base_id = self.core.getPath(self.core.getBase(self._nodeCache[child_id]));
      if (base_id === self.core.getPath(self.META['Parameter_Input']) || base_id === self.core.getPath(self.META['Signal_Input'])){
        inputs[child_id] = 0;
        inputsRegular.push(child_id);
      } else if (base_id === self.core.getPath(self.META['Ordering_Flow'])) {
        orderingFlows.push(child_id);
      } else if (base_id === self.core.getPath(self.META['Buffer_Flow'])) {
        bufferFlows.push(child_id);
      }
    });

    if (inputsRegular.length == 0 )
      return self.core.getAttribute(node,'name') + '();';

    var initialInput = {};
    orderingFlows.forEach(function(flow) {
      var flow_node = self._nodeCache[flow],
        src = self.core.getPointerPath(flow_node,'src'),
        dst = self.core.getPointerPath(flow_node,'dst');
      inputs[src] = dst;
      initialInput[dst] = 1;
    });

    var initInp;
    inputsRegular.forEach(function(inputRegular) {
      if (!initialInput[inputRegular]) {
        initInp = inputRegular;
      }
    });

    var isInputOutputConnected = [];
    bufferFlows.forEach(function(bf) {
      var buf_flow_node = self._nodeCache[bf],
        src = self.core.getPointerPath(buf_flow_node,'src');
      isInputOutputConnected[src] = true;
    });

    //check if the type and pointer values of buffer flow src & dst match
    for (var i = bufferFlows.length - 1; i >= 0; i--) {
      var src = self.core.getPointerPath(self._nodeCache[bufferFlows[i]], 'src');
      var dst = self.core.getPointerPath(self._nodeCache[bufferFlows[i]], 'dst');
      var sn = self._nodeCache[src];
      var dn = self._nodeCache[dst];

      if (!doTheTypesMatch(sn, dn, 'type') || !doTheTypesMatch(sn, dn, 'pointer')) {
        var name = self.core.getAttribute(node, 'name');
        self._errorMessages('Buffer flow type or pointer do not match on ' + name);
        return null;
      }
    };

    function doTheTypesMatch(src, dst, attr) {
      if (self.core.getAttribute(src, attr) !== self.core.getAttribute(dst, attr))
        return false;
      return true;
    }

    var functionCall = self.core.getAttribute(node,'name') + '(',
      curr = initInp;
    var counter = 0;
    while(inputs[curr] != 0) {
      var nameOfInput = getNameOfInput(procs[node_id]['inputs'][curr], isInputOutputConnected[curr]);
      if (nameOfInput == null) return null;
      functionCall += nameOfInput + ',';
      curr = inputs[curr];
      counter++;
    }
    var nameOfInput = getNameOfInput(procs[node_id]['inputs'][curr], isInputOutputConnected[curr]);
    if (nameOfInput == null) {
      return null;
    }
    functionCall += nameOfInput + ');';
    counter++;

    if(counter != inputsRegular.length || inputsRegular.length != (orderingFlows.length+1)) {
      self._errorMessages('Ordering Flow error in ' + self.core.getAttribute(node, 'name'));
      return null;
    }

    // put in a datastructure
    return functionCall;

    //if the incoming edge is output, get the name of input registered inside the proc..
    // this needs to run recursively for now
    //nd is the output port
    function getNameOfInput(nd, isOutputToo) {
      var nn = self._nodeCache[nd];
      if (!nn) {
        self._errorMessages('Problem with proc definition');
        self.result.setSuccess(false);
        // callback(null,self.result);
        return null;
      }
      if (self.core.getPath(self.core.getBase(nn)) === self.core.getPath(self.META['Primitive_Parameter'])  ) { //|| !self.core.getAttribute(nn,'pointer')
        var param = isOutputToo ? '&' : '';
        param += self.core.getAttribute(nn,'name');
        return param;
      } else if (self.core.getPath(self.core.getBase(nn)) === self.core.getPath(self.META['Buffer'])) {
        var param = '';
        if (!self.core.getAttribute(nn,'pointer')) {
          param += isOutputToo ? '&' : '';  
        }
        param += self.core.getAttribute(nn,'name');
        return param;
      } else if (self.core.getPath(self.core.getBase(nn)) == self.core.getPath(self.META['Output'])) {
        var parent_id = self.core.getPath(self.core.getParent(nn));
        var parent_node = self.core.getParent(nn);
        var childrenIds = self.core.getChildrenPaths(parent_node);
        for (var i = 0; i < childrenIds.length; i++) {
          var curr_node = self._nodeCache[childrenIds[i]];
          var curr_node_base_id = self.core.getPath(self.core.getBase(curr_node));
          if (curr_node_base_id === self.core.getPath(self.META['Buffer_Flow'])) {
            // var np = self._client.getNode(curr_node_base_id);
            var src_input = self.core.getPointerPath(curr_node,'src');
            return getNameOfInput(procs[parent_id]['inputs'][src_input], isOutputToo);
          }
        }
      }
      self._errorMessages("There's a problem with a proc definition");
      return null;
    }


  };

  return TurbulencePlugin;
});