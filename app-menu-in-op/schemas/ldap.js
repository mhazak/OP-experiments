var LDAPSYNC = null;

NEWSCHEMA('LDAP', function(schema) {

	schema.define('url', String);
	schema.define('user', String, true);
	schema.define('password', String, true);
	schema.define('dn', String);
	schema.define('active', Boolean);
	schema.define('interval', String);
	schema.define('mapper', String);
	schema.define('noauth', Boolean);

	var insert = function(doc, id) {
		doc.id = id;
		doc.name = id;
		delete doc.dtupdated;
		doc.dtcreated = NOW;
	};

	schema.setRead(function($) {

		if ($.controller && FUNC.notadmin($))
			return;

		var data = {};
		for (var i = 0; i < schema.fields.length; i++) {
			var key = schema.fields[i];
			data[key] = CONF['ldap_' + key];
		}

		$.callback(data);
	});

	schema.setSave(function($, model) {

		if ($.controller && FUNC.notadmin($))
			return;

		var db = DBMS();
		for (var key in model) {
			var nk = 'ldap_' + key;
			var data = { type: key === 'active' ? 'boolean' : 'string', value: model[key] + '', dtupdated: NOW };
			db.modify('config', data, true).id(nk).insert(insert, nk);
			CONF[nk] = model[key];
		}

		db.callback($.done());
	});

	schema.addWorkflow('test', function($, model) {

		if ($.controller && FUNC.notadmin($))
			return;

		var opt = {};
		opt.ldap = FUNC.ldap_host(model.url);
		opt.type = 'group';
		opt.dn = model.dn;
		opt.user = model.user;
		opt.password = model.password;
		opt.noauth = model.noauth;
		LDAP(opt, $.done());
	});

	schema.addWorkflow('import', function($) {

		if ($.controller && FUNC.notadmin($))
			return;

		import_groups($.successful(function() {
			import_users($.done(true));
		}));
	});

});

FUNC.ldap_import = function(login, callback) {

	var opt = {};
	opt.ldap = FUNC.ldap_host();
	opt.type = 'profile';
	opt.dn = CONF.ldap_dn;
	opt.user = CONF.ldap_user;
	opt.password = CONF.ldap_password;
	opt.login = login;

	LDAP(opt, async function(err, item) {

		if (err) {
			callback(err);
			return;
		}

		if (!item) {
			callback(409);
			return;
		}

		var map = {};
		var mapper = (CONF.ldap_mapper || '').split(/,|;/);

		for (var i = 0; i < mapper.length; i++) {
			var tmp = mapper[i].split(/=|:/).trim();
			if (tmp[0] && tmp[1])
				map[tmp[0]] = tmp[1];
		}

		var model = {};

		if (map.reference)
			model.reference = item[map.reference];

		if (!model.reference)
			model.reference = item.sAMAccountName;

		if (!model.reference) {
			callback(409);
			return;
		}

		if (CONF.ldap_user.indexOf(model.reference) !== -1) {
			callback(409);
			return;
		}

		var groups = [];

		if (item.memberOf) {
			if (!(item.memberOf instanceof Array))
				item.memberOf = [item.memberOf];
			for (var i = 0; i < item.memberOf.length; i++) {
				var dn = item.memberOf[i].split(',', 1)[0];
				var index = dn.indexOf('=');
				if (index !== -1)
					groups.push(dn.substring(index + 1));
			}
		}

		if (map.name)
			model.name = item[map.name];

		if (!model.name)
			model.name = item.displayName || '';

		var arr = model.name.split(' ');
		model.firstname = arr[0];
		model.lastname = arr[1];
		model.gender = 'male';
		model.language = CONF.language || 'en';
		model.timeformat = CONF.timerformat || 24;
		model.dateformat = CONF.dateformat || 'yyyy-MM-dd';
		model.numberformat = CONF.numberformat || 1;
		model.volume = 50;
		model.sounds = true;
		model.notifications = true;
		model.notificationsemail = true;
		model.notificationsphone = true;
		model.desktop = CONF.desktop || 3;

		model.login = item.sAMAccountName;
		model.email = item.mail || item.userPrincipalName;
		model.dn = item.distinguishedName;
		model.groups = groups;
		model.inactive = false;

		// OP_NAME=LDAP_NAME
		for (var key in map)
			model[key] = item[map[key]];

		model.checksum = (model.name + '_' + (model.dn || '') + '_' + model.email + '_' + groups.join(',')).makeid();

		if (!model.dn) {
			FUNC.log('LDAP/Error.users', model.reference, model.reference + ': Empty DN', { model: model, ldap: item });
			callback(409);
			return;
		}

		if (!model.name) {
			FUNC.log('LDAP/Error.users', model.reference, model.reference + ': Empty name', { model: model, ldap: item });
			callback(409);
			return;
		}

		if (!model.email) {
			FUNC.log('LDAP/Error.users', model.reference, model.reference + ': Empty email', { model: model, ldap: item });
			callback(409);
			return;
		}

		EXEC('+Users --> insert', model, function(err, response) {
			err && FUNC.log('LDAP/Error.users', model.reference, model.reference + ': ' + err + '', { model: model, ldap: item });
			callback(err, response.value);
		});

	});

};

FUNC.ldap_host = function(url) {
	var uri = new URL(((url || CONF.ldap_url) || 'ldap://localhost:389').replace('ldap', 'http'));
	return { host: uri.hostname, port: +(uri.port || 389), timeout: +(uri.searchParams.get('timeout') || 3000) };
};

function import_groups(callback) {

	if (!CONF.ldap_active) {
		callback('@(LDAP is inactive)');
		return;
	}

	var opt = {};
	opt.ldap = FUNC.ldap_host();
	opt.type = 'group';
	opt.dn = CONF.ldap_dn;
	opt.user = CONF.ldap_user;
	opt.password = CONF.ldap_password;
	opt.noauth = CONF.ldap_noauth;

	LDAP(opt, async function(err, response) {

		if (err) {
			callback && callback(err);
			return;
		}

		response.wait(function(item, next) {

			var name = item.sAMAccountName;
			if (REPO.groups.findItem('id', name)) {
				next();
				return;
			}

			var model = {};
			model.id = name;
			model.name = name;

			EXEC('+Users/Groups --> patch', model, function(err) {
				err && FUNC.log('LDAP/Error.group', model.id, err + '', { model: model });
				next();
			});

		}, callback);

	});
}

function import_users(callback) {

	if (!CONF.ldap_active) {
		callback('@(LDAP is inactive)');
		return;
	}

	var opt = {};
	opt.ldap = FUNC.ldap_host();
	opt.type = 'person';
	opt.dn = CONF.ldap_dn;
	opt.user = CONF.ldap_user;
	opt.password = CONF.ldap_password;
	opt.noauth = CONF.ldap_noauth;

	var map = {};
	var mapper = (CONF.ldap_mapper || '').split(/,|;/);

	for (var i = 0; i < mapper.length; i++) {
		var tmp = mapper[i].split(/=|:/).trim();
		if (tmp[0] && tmp[1])
			map[tmp[0]] = tmp[1];
	}

	LDAP(opt, async function(err, response) {

		if (err && (!response || !response.length)) {
			callback && callback(err);
			return;
		}

		var stamp = GUID(10);
		var updated = [];
		var countupdated = 0;
		var countinserted = 0;

		response.wait(function(item, next) {

			var model = {};

			if (map.reference)
				model.reference = item[map.reference];

			if (!model.reference)
				model.reference = item.sAMAccountName;

			if (!model.reference) {
				next();
				return;
			}

			if (CONF.ldap_user.indexOf(model.reference) !== -1) {
				next();
				return;
			}

			var groups = [];

			if (item.memberOf) {
				if (!(item.memberOf instanceof Array))
					item.memberOf = [item.memberOf];
				for (var i = 0; i < item.memberOf.length; i++) {
					var dn = item.memberOf[i].split(',', 1)[0];
					var index = dn.indexOf('=');
					if (index !== -1)
						groups.push(dn.substring(index + 1));
				}
			}

			if (map.name)
				model.name = item[map.name];

			if (!model.name)
				model.name = item.displayName || '';

			model.login = item.sAMAccountName;
			model.email = item.mail || item.userPrincipalName;
			model.dn = item.distinguishedName;

			// OP_NAME=LDAP_NAME
			for (var key in map)
				model[key] = item[map[key]];

			if (!model.dn) {
				FUNC.log('LDAP/Error.users', model.reference, model.reference + ': Empty DN', { model: model, ldap: item });
				next();
				return;
			}

			if (!model.name) {
				FUNC.log('LDAP/Error.users', model.reference, model.reference + ': Empty name', { model: model, ldap: item });
				next();
				return;
			}

			if (!model.email) {
				FUNC.log('LDAP/Error.users', model.reference, model.reference + ': Empty email', { model: model, ldap: item });
				next();
				return;
			}

			model.checksum = (model.name + '_' + (model.dn || '') + '_' + model.email + '_' + groups.join(',')).makeid();

			var user = REPO.users.findItem('reference', model.reference);
			if (user) {

				model.id = user.id;
				countupdated++;

				if (model.checksum === user.checksum) {
					updated.push(model.id);
					next();
					return;
				}

			} else {

				if (!model.name) {
					FUNC.log('LDAP/Error.users', model.reference, model.reference + ': Empty name', { model: model, ldap: item });
					next();
					return;
				}

				var arr = model.name.split(' ');
				model.firstname = arr[0];
				model.lastname = arr[1];
				model.gender = 'male';
				model.language = CONF.language || 'en';
				model.timeformat = CONF.timerformat || 24;
				model.dateformat = CONF.dateformat || 'yyyy-MM-dd';
				model.numberformat = CONF.numberformat || 1;
				model.volume = 50;
				model.sounds = true;
				model.notifications = true;
				model.notificationsemail = true;
				model.notificationsphone = true;
				model.desktop = CONF.desktop || 3;
				countinserted++;
			}

			model.groups = groups;
			model.stamp = stamp;
			model.inactive = false;

			// OP_NAME=LDAP_NAME
			for (var key in map)
				model[key] = item[map[key]];

			var ctrl = EXEC((model.id ? '#' : '+') + 'Users --> ' + (model.id ? 'patch' : 'insert'), model, function(err) {
				err && FUNC.log('LDAP/Error.users', model.reference, model.reference + ': ' + err + '', { model: model, ldap: item });
				next();
			});

			ctrl.id = model.id;

		}, function() {

			var countremoved = 0;

			for (var i = 0; i < REPO.users.length; i++) {
				var item = REPO.users[i];
				if (item.dn && item.stamp !== stamp) {
					item.inactive = true;
					countremoved++;
				}
			}

			callback && callback(err, { countremoved: countremoved, inserted: countinserted, updated: countupdated });
		});

	});
}

// Auto-synchronization
ON('service', function() {
	if (CONF.ldap_active) {
		if (LDAPSYNC) {
			if (LDAPSYNC < NOW) {
				LDAPSYNC = NOW.add(CONF.ldap_interval);
				import_groups(function(err) {
					if (!err)
						import_users();
				});
			}
		} else
			LDAPSYNC = NOW.add(CONF.ldap_interval);
	}
});