/**
 * ModuleContainer
 * @author calbertts
 *
 * This class handles all the stuff relates with:
 *
 *    Controllers and HTTP methods
 *    Dependency Injection
 */

import fs from 'fs'
import path_module from 'path'
import NodeSpringUtil from './nodeSpringUtil'
import NodeSpringException from '../exceptions/NodeSpringException'


global.modulesContainer = {}
let modulesContainer = global.modulesContainer

export default class ModuleContainer {

  static appDir = null
  static implConfig = {}
  static nodeSpringApp = {
    bindURL: () => {},
    addSocketListener: () => {}
  }

  static init(appDir, nodeSpringApp, implConfig, logging = false, loggingSync = false, debugging = false) {
    NodeSpringUtil.logging = logging
    NodeSpringUtil.configureLoggingOut(loggingSync)
    NodeSpringUtil.debugging = debugging

    ModuleContainer.appDir = appDir
    ModuleContainer.implConfig = implConfig
    ModuleContainer.nodeSpringApp = nodeSpringApp
  }

  static loadModules() {
    let load = (path) => {
      fs.lstat(path, (err, stat) => {
        if(err)
          throw err
        else if (stat.isDirectory()) {
          fs.readdir(path, (err, files) => {
            let f, l = files.length
            for (let i = 0; i < l; i++) {
              f = path_module.join(path, files[i])
              load(f)
            }
          })
        } else {
          if(path.indexOf('.map') < 0) {
            NodeSpringUtil.debug("Loading file => " + path)
            require(path)
          }
        }
      })
    }

    let baseDir = path_module.join(ModuleContainer.appDir)
    load(baseDir)
  }

  static addService(moduleDef) {
    let moduleName = moduleDef.packagePath

    ModuleContainer.addInterface(moduleName)
    modulesContainer[moduleName].impl = new moduleDef()
    modulesContainer[moduleName].moduleType = moduleDef.moduleType

    ModuleContainer.runInjectionResolver(moduleName)
  }

  static addController(moduleDef, path) {
    let moduleName = moduleDef.packagePath

    ModuleContainer.addInterface(moduleName)
    modulesContainer[moduleName].path = path
    modulesContainer[moduleName].impl = new moduleDef()
    modulesContainer[moduleName].moduleType = moduleDef.moduleType

    ModuleContainer.runInjectionResolver(moduleName)

    let moduleInfo = modulesContainer[moduleName]

    let processRequest = (req, res, methodInfo) => {
      let fn = moduleInfo.impl[methodInfo.methodName]

      ModuleContainer.nodeSpringApp.getRequestParams(req, (params) => {
        let fullParams = NodeSpringUtil.getArgs(fn).map((item, index) => {
          return params[item] || (params[item + '[]'] instanceof Array ? params[item + '[]'] : [params[item + '[]']])
        })

        let handleResponse = (data) => {
          ModuleContainer.nodeSpringApp.setContentTypeResponse(res, methodInfo.contentType)

          if(methodInfo.contentType === 'application/json') {
            ModuleContainer.nodeSpringApp.sendJSONResponse(res, data)
          } else {
            ModuleContainer.nodeSpringApp.sendDataResponse(res, data)
          }
        }

        // Getting method response
        fn.request = req
        fn.response = res
        let value = fn.apply(moduleInfo.impl, fullParams)

        // Clear
        delete fn.request
        delete fn.response

        if(value !== undefined) {
          if(value instanceof Promise) {
            value
              .then((data) => {
                handleResponse(data)
              })
              .catch((err) => {
                handleResponse([])
              })
          } else {
            handleResponse(value)
          }
        }
      })
    }

    moduleInfo.socketListeners.forEach((socketListener) => {
      let handler = moduleInfo.impl[socketListener.methodName]

      ModuleContainer.nodeSpringApp.addSocketListener(socketListener.eventName, handler, moduleInfo.impl)
    })

    // Bind index method
    ModuleContainer.nodeSpringApp.bindURL('get', `/${path}`, (req, res) => {
      processRequest(req, res, {methodName: 'index'})
    })

    // Bind the other endpoints
    moduleInfo.methods.forEach((methodInfo) => {
      ModuleContainer.nodeSpringApp.bindURL(methodInfo.httpMethod, `/${path}/${methodInfo.methodName}`, (req, res) => {
        processRequest(req, res, methodInfo)
      })
    })
  }

  static addRoute(moduleDef, methodName, httpMethod, contentType) {
    let moduleName = moduleDef.packagePath

    ModuleContainer.addInterface(moduleName)

    modulesContainer[moduleName].methods.push({
      methodName: methodName,
      httpMethod: httpMethod,
      contentType: contentType
    })
  }

  static addSocketListener(moduleDef, methodName, eventName) {
    let moduleName = moduleDef.packagePath

    ModuleContainer.addInterface(moduleName)

    modulesContainer[moduleName].socketListeners.push({
      methodName: methodName,
      eventName: eventName ? eventName : methodName
    })
  }

  static validateImpl(type, impl) {
    ModuleContainer.addInterface(type.packagePath)

    let interfaceMethods = Object.getOwnPropertyNames(type.prototype)
    let implementationMethods = Object.getOwnPropertyNames(impl.prototype)

    interfaceMethods.filter((methodName) => {
      return methodName !== 'constructor'
    }).forEach(methodName => {
      let isMethodImplemented = implementationMethods.indexOf(methodName) >= 0

      if (!isMethodImplemented) {
        let errorMessage = `The method "${methodName}" declared in ${type.packagePath} is not implemented in ${impl.name}`
        let methodNotImplemented = new NodeSpringException(errorMessage, ModuleContainer.addImplementation, 1)

        NodeSpringUtil.throwNodeSpringException(methodNotImplemented)
      } else {
        NodeSpringUtil.getArgs(type.prototype[methodName]).forEach((param) => {
          let implMethodParams = NodeSpringUtil.getArgs(impl.prototype[methodName])
          let isParamPresent = implMethodParams.indexOf(param) >= 0

          if (!isParamPresent) {
            let errorMessage = `The param "${param}" declared in ${type.packagePath}.${methodName}(...) is not present in ${impl.name}.${methodName}(...)`
            let missingParam = new NodeSpringException(errorMessage, ModuleContainer.addImplementation, 1)

            NodeSpringUtil.throwNodeSpringException(missingParam)
          }
        })
      }
    })

    return true
  }

  static addInterface(type) {
    if (!ModuleContainer.existsInterface(type)) {
      modulesContainer[type] = {
        impl: null,
        dependents: {},
        dependencies: {},
        methods: [],
        socketListeners: [],
        instanceResolvedValue: false,
        isInstanceResolved: () => {
          if(modulesContainer[type].moduleType === 'service' || modulesContainer[type].moduleType === 'controller') {
            return modulesContainer[type].impl !== null
          } else {
            return modulesContainer[type].instanceResolvedValue
          }
        },
        getInstance: () => {
          if(modulesContainer[type].moduleType === 'service' || modulesContainer[type].moduleType === 'controller') {
            return new Promise((resolve, reject) => {
              resolve(modulesContainer[type].impl)
            })
          } else {
            let moduleInfo = modulesContainer[type]
            let dependencies = moduleInfo.dependencies

            NodeSpringUtil.debug('getInstance for an Impl', type, dependencies)

            if (Object.keys(dependencies).length > 0) {
              NodeSpringUtil.debug('has dependencies')

              let dependenciesInstancesPromises = []
              let mapImplVariable = {}

              for(let property in dependencies) {
                let moduleNeeded = dependencies[property]

                let promise = modulesContainer[moduleNeeded].getInstance()

                mapImplVariable[moduleNeeded] = property

                dependenciesInstancesPromises.push(promise)
              }

              let mainPromise = new Promise((resolve, reject) => {

                /**
                 * Wait for the dependencies are resolved to be injected
                 * in the instance that's being created
                 */
                /*Promise.all(dependenciesInstancesPromises).then((instances) => {
                  NodeSpringUtil.debug('another listener')
                })*/

                Promise.all(dependenciesInstancesPromises).then((instances) => {
                  NodeSpringUtil.debug('official promises resolved')

                  //console.log('official promises resolved')

                  //NodeSpringUtil.error('Promise scope', type, modulesContainer[type].scope)
                  let mainInstance = modulesContainer[type].impl.scope === 'prototype' ? new modulesContainer[type].impl() : modulesContainer[type].impl

                  console.log('instanceResolvedValue => ', modulesContainer[type].instanceResolvedValue = true)
                  console.log('Setting for', type)
                  instances.forEach((instanceToInject) => {
                    //console.log('instanceToInject', instanceToInject)

                    let varType = instanceToInject.constructor.interfacePackagePath
                    let property = mapImplVariable[varType]

                    mainInstance[property] = instanceToInject
                  })

                  // Call the init method once all the dependencies are created and injected
                  let postInjectMethod = modulesContainer[type].postInjectMethod

                  if(postInjectMethod) {
                    //console.log('type', type, postInjectMethod)
                    mainInstance[postInjectMethod]()
                  }

                  // Resolve the complete instance to the modules which are waiting for it
                  resolve(mainInstance)
                }).catch((err) => {
                  NodeSpringUtil.error('Error resolving instance for', type, err)
                })
              })

              return mainPromise
            } else {

              //NodeSpringUtil.debug('return instance without dependencies', type)

              /**
               * If the module doesn't have dependencies, returns the impl if it's loaded or
               * will wait for the implementation that is loaded to dispatch the instance.
               */
              return new Promise((resolve, reject) => {
                if(modulesContainer[type].impl) {
                  NodeSpringUtil.debug('No dependencies, instance resolved')
                  modulesContainer[type].instanceResolvedValue = true

                  if(modulesContainer[type].impl.scope) {
                    if(modulesContainer[type].impl.scope === 'singleton')
                      resolve(modulesContainer[type].impl)
                    else if(modulesContainer[type].impl.scope === 'prototype')
                      resolve(new modulesContainer[type].impl())
                  } else {
                    resolve(modulesContainer[type].impl)
                  }
                  //resolve(!modulesContainer[type].impl.scope ? modulesContainer[type].impl : new modulesContainer[type].impl())
                } else {
                  NodeSpringUtil.debug('No dependencies, observing for impl to be resolved')

                  Object.observe(modulesContainer[type], (changes) => {
                    NodeSpringUtil.debug('impl arrived', type)

                    let change = changes.filter((change) => change.type === 'update')[0]

                    modulesContainer[type].instanceResolvedValue = true
                    resolve(!modulesContainer[type].impl.scope ? modulesContainer[type].impl : new modulesContainer[type].impl())
                  })
                }
              })
            }
          }
        },
        injectDependency: (property, impl) => {
          modulesContainer[type].impl[property] = impl
        }
      }
    }
  }

  static existsInterface(type) {
    return modulesContainer[type] !== undefined
  }

  static resolveDependencies(type, dependencies) {
    for(let property in dependencies) {
      let expectedType = dependencies[property]

      NodeSpringUtil.debug('expectedType', expectedType)

      if(ModuleContainer.existsInterface(expectedType) && modulesContainer[expectedType].isInstanceResolved()) {
        //NodeSpringUtil.debug('exist!')

        modulesContainer[expectedType].getInstance().then((instance) => {
          //NodeSpringUtil.debug('promise resolved:', instance)
          modulesContainer[type].injectDependency(property, instance)

          let targetInstanceName = modulesContainer[type].impl.scope ? modulesContainer[type].impl.name : modulesContainer[type].impl.constructor.name
          NodeSpringUtil.log('Dispatching an instance of ', modulesContainer[expectedType].impl.constructor.name, ' for ', targetInstanceName + '.' + property)
        })
      } else {
        NodeSpringUtil.debug('doesnt exist!')
        if(!ModuleContainer.existsInterface(expectedType)) {
          NodeSpringUtil.debug('creating!')
          ModuleContainer.addInterface(expectedType)
        }

        //NodeSpringUtil.debug('modulesContainer[expectedType]', modulesContainer[expectedType])

        let myOwnDependents = modulesContainer[expectedType].dependents[type] = {}

        myOwnDependents[property] = {
          dispatched: false,
          callback: (instance) => {
            NodeSpringUtil.debug("I'm here!", instance)
            modulesContainer[type].injectDependency(property, instance)

            let targetInstanceName = modulesContainer[type].impl.scope ? modulesContainer[type].impl.name : modulesContainer[type].impl.constructor.name
            NodeSpringUtil.log('Dispatching an instance of ', instance.constructor.name, ' for ', targetInstanceName + '.' + property)
          }
        }
      }
    }
  }

  static dispatchDependents(type, dependents) {
    for(let className in dependents) {
      let classProperties = dependents[className]

      for(let property in classProperties) {
        let resolverCallbackInfo = classProperties[property]

        modulesContainer[type].getInstance().then((instance) => {
          if(!resolverCallbackInfo.dispatched) {
            resolverCallbackInfo.callback(instance)
            resolverCallbackInfo.dispatched = true
          }
        }).catch((err) => {
          NodeSpringUtil.error('Error dispatching instance for the property', property)
        })
      }
    }
  }

  static runInjectionResolver(type) {

    //NodeSpringUtil.debug('type, modulesContainer[type].dependencies', type, modulesContainer[type].dependencies)

    // Resolve dependencies
    ModuleContainer.resolveDependencies(type, modulesContainer[type].dependencies)

    // Dispatch dependents registered dependents
    ModuleContainer.dispatchDependents(type, modulesContainer[type].dependents)

    // Wait for future dependents to be resolved
    Object.observe(modulesContainer[type].dependents, (changes) => {
      ModuleContainer.dispatchDependents(type, modulesContainer[type].dependents)
    })
  }

  static addDependency(type, property, typeToInject) {
    ModuleContainer.addInterface(type)
    modulesContainer[type].dependencies[property] = typeToInject.packagePath
  }

  static addImplementation(type, impl) {
    if(ModuleContainer.validateImpl(type, impl)) {
      modulesContainer[type.packagePath].impl = (impl.scope === 'prototype') ? impl : new impl()
      ModuleContainer.runInjectionResolver(type.packagePath)
    }
  }

  static addPostInjectMethod(type, methodName) {
    modulesContainer[type].postInjectMethod = methodName
  }

  static getModuleContainer() {
    return modulesContainer
  }

  static clearModuleContainer() {
    modulesContainer = {}
  }
}
