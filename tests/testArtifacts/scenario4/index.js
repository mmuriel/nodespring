/**
 * This scenario test when there are more than one implementation of an interface
 */

(function() {
  require('./InterfaceTest')
  require('./InterfaceTestImpl')

  require('./InterfaceTest2')
  require('./InterfaceTest2Impl')
})()