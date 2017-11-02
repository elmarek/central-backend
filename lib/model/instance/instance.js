const { merge, omit } = require('ramda');

// Instances are simple databags representing model records, with convenience
// methods sprinkled in to ease the readability of common tasks.
//
// InstanceBase is the only common superclass to them all.
class InstanceBase {
  forCreate() { return this; }
  forSerialize() { return this; }

  // Returns a new copy of this instance with merged properties.
  with(data) {
    return new (this.constructor)(merge(this, data));
  }

  // Returns a new copy of this instance omitting the requested properties.
  without(...fields) {
    return new (this.constructor)(omit(fields, this));
  }
}

// TODO: look, this is evil. but it doesn't seem possible to make the interface
// we all come closest to liking without some evilness /somewhere/ in the guts,
// at least given my limited skills.
//
// We cannot use Object.assign as it will not assign non-enumerable properties.
const assignAll = (target, source) => {
  for (const property of Object.getOwnPropertyNames(source))
    if (typeof source[property] === 'function')
      target[property] = source[property]; // eslint-disable-line no-param-reassign
};

// Given an anonymous class, creates a new Instance class based on the Instance
// base behaviour as well as any supplied traits/mixins.
//
// Largely follows mixin pattern described on MDN's Object.create page, but with
// a two-part synthesis process so that a stub may be returned to the injection
// system.
const builder = (traitDefs) => {
  // Create a bag of traits to be fulfilled once we obtain our container.
  const traits = [];

  // Create a new constuctor and base it off InstanceBase.
  const Instance = function(data) {
    Object.assign(this, data);
    Object.freeze(this);

    for (const trait of traits) trait.constructor.call(this);
  };
  Instance.prototype = Object.create(InstanceBase.prototype);

  return [ Instance, (container) => {
    // Feed our injection container to the traitDefs to get concrete classes,
    // and push the result into our trait bag.
    for (const traitDef of traitDefs)
      traits.push(traitDef(container));

    // Decorate trait instance and static methods.
    for (const trait of traits) {
      assignAll(Instance.prototype, trait.prototype);
      assignAll(Instance, trait);
    }

    // Reassign constructor as it gets clobbered.
    Instance.prototype.constructor = Instance;
  } ];
};

// Our exposed interface are just two remixed exposures of the builder. The
// default for the bare case is to assume a single trait. The .with convenience
// builder takes a bunch of (presumably named) traits first.
const Instance = (def) => builder([ def ]);
Instance.with = (...traits) => (def) => builder(traits.concat([ def ]));
module.exports = Instance;
