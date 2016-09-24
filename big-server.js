require('log-timestamp');
var _ = require('underscore');
var express = require('express');
//var expressJwt = require('express-jwt');
//var jwt = require('jsonwebtoken');
var bodyParser = require('body-parser');
var splunkjs = require('splunk-sdk');
var app = express();
var jsonParser = bodyParser.json();
var schedule = require('node-cron');
var http = require('http');
var config = require('./config.json');
var winston = require('winston');

new (winston.transports.Console)({'timestamp':true})

var logger = new(winston.Logger)({
    transports: [
        new(winston.transports.Console)({
            'level': config.logLevel,
            'timestamp': true
        }),
        new(winston.transports.File)({
            'filename': 'big-server.log',
            'level': config.logLevel,
            'timestamp': true
        })
    ]
});

var schedules = {
    EVERY_1_MIN: 'EVERY_1_MIN',
    EVERY_2_MIN: 'EVERY_2_MIN',
    EVERY_5_MIN: 'EVERY_5_MIN',
    EVERY_5_MIN: 'EVERY_10_MIN',
    EVERY_15_MIN: 'EVERY_15_MIN',
    EVERY_30_MIN: 'EVERY_30_MIN',
    EVERY_1_HR: 'EVERY_1_HR',
    EVERY_12_HR: 'EVERY_12_HR'
}

// Create a Splunk Service instance and log in
var splunkService = new splunkjs.Service({
    username: config.splunkConfig.username,
    password: config.splunkConfig.pasword,
    scheme: config.splunkConfig.scheme,
    host: config.splunkConfig.host,
    port: config.splunkConfig.port,
    version: config.splunkConfig.version
});

var getPointsForSchedule = function(schedule, jaceId) {
    var points = [];
    _.each(config.points, function(point) {
        if (point.schedule == schedule && point.jaceId == jaceId) {
            points.push(point);
        }
    });
    return points;
}

var buildReadPointsPostBody = function(points) {
    var value = 'ver:"2.0"\n';
    value += 'id\n';
    _.each(points, function(point) {
        value += point.id;
        value += '\n';
    });
    return value;
}

var readAndLogWeather = function(schedule) {
    if (config.weatherConfig.schedule == schedule) {
        logger.info(">>>>>>>>>> Logging weather data: " + schedule);
        var getOptions = {
            host: config.weatherConfig.host,
            path: config.weatherConfig.path,
            method: 'GET'
        };

        var getReq = http.get(getOptions, function(res) {
            var response = '';
            res.on('data', function(chunk) {
                response += chunk;
            });
            res.on('end', function() {
                logger.debug('Weather response: ' + response);
                logToSplunk(config.splunkConfig.weatherIndex, response);
            });
        });
    }
}

var readAndLogPointValues = function(points, jaceId) {
    var jaceConfig = getJaceConfigForId(jaceId);
    if (points && jaceConfig) {
        var postBody = buildReadPointsPostBody(points);
        var auth = 'Basic ' + new Buffer(jaceConfig.username + ':' + jaceConfig.password, "utf8").toString('base64');
        var postOptions = {
            host: jaceConfig.host,
            port: '80',
            path: '/haystack/read',
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'text/zinc',
                'Authorization': auth
            }
        };

        var postReq = http.request(postOptions, function(res) {
            var response = '';
            res.setEncoding('utf8');
            res.on('data', function(chunk) {
                response += chunk;
            });
            res.on('end', function() {
                logger.debug('Read points response: ' + response);
                var records = [];
                try {
                    records = JSON.parse(response).rows;
                } catch (err) {
                    logger.error('>>>> Could not parse json response from JACE.')
                    logger.error(err);
                }
                logPointValues(records);
                return records;
            });
        });

        postReq.write(postBody);
        postReq.end();

        return postReq;
    }
}

var logPointValues = function(records) {
    logger.info('>>>>> Retrieved [ ' + records.length + ' ] point values');
    var j = 0;
    _.each(records, function(row, i) {
        if ('curVal' in row) {
          j++;
          row = cleanseData(row);
          logToSplunk(config.splunkConfig.pointsIndex, row);
          // delay 50 millis between each splunk log, needed to avoid multiple event payloads in one event
          // setTimeout(function () {
          //   logger.info('>>>>> point logged to splunk');
          //   logToSplunk(config.splunkConfig.pointsIndex, row);
          // }, 50 * i);
        } else {
          logger.debug('>>>>>>>>>> Not logging point with Id [ ' + row.id + ' ] because it is has no curVal');
        }

    });

    logger.info('>>>>> Logged total of [ ' + j + ' ] point values');
}

var cleanseData = function(rawData) {
    // remove data that is returned from the JACE but doesn't need to be loged.  This reduced payload to splunk.
    delete rawData.actions;
    delete rawData.cur;
    delete rawData.writable;
    delete rawData.enum;
    delete rawData.point;
    delete rawData.axType;
    // remove repeated point id info, if exists
    var indexOfFirstSpace = rawData.id.indexOf(' ');
    rawData.id = rawData.id.substring(0, indexOfFirstSpace);
    // remove the "r:" prefix if it exists
    if (rawData.id.indexOf('r:') > -1){
      rawData.id = rawData.id.substring(2,rawData.id.length);
    }
    if (rawData.kind == 'Number') {
      rawData.curVal = cleanseNumeric(rawData.curVal)
    }
    if ('precision' in rawData) {
      rawData.precision = cleanseNumeric(rawData.precision)
    }
    if ('maxVal' in rawData) {
      rawData.maxVal = cleanseNumeric(rawData.maxVal)
    }
    if ('minVal' in rawData) {
      rawData.minVal = cleanseNumeric(rawData.minVal)
    }
    return rawData;
}

var cleanseNumeric = function(value) {
  // remove any prefixes or non-numeric characters from the value.
  // ex: "n:73.987 F" --> 73.987
  return Number(value.replace(/[^0-9\.]+/g,""));
}

var logToSplunk = function(index, payload) {
    if (config.splunkLoggingEnabled) {
        return splunkService.log(payload, {
            index: index,
            sourcetype: "big-server"
        }, function(err, result) {
            if (err) {
                logger.error(">>>>> Error logging data to Splunk")
                logger.error(err);
            }
        });
    }
}

var getJaceIds = function() {
  var jaceIds = [];
  _.each(config.points, function(point) {
    jaceIds.push(point.jaceId);
  });
  return _.uniq(jaceIds);
}

var getJaceConfigForId = function(jaceId) {
  var jaceConfig = null;
  _.each(config.jaces, function(jace) {
    if (jace.id == jaceId) {
      jaceConfig = jace;
    }
  });
  return jaceConfig;
}

var initiateScheduledPointLogging = function(schedule) {
  var jaceIds = getJaceIds();
  _.each(jaceIds, function(jaceId) {
    readAndLogPointValues(getPointsForSchedule(schedule, jaceId), jaceId);
  });
}

var s5 = schedule.schedule('0 */2 * * * *', function() {
    logger.info(">>>>> Start 2 minute scheduled job");
    initiateScheduledPointLogging(schedules.EVERY_2_MIN);
    readAndLogWeather(schedules.EVERY_2_MIN);
});
// var s5 = schedule.schedule('0 */5 * * * *', function() {
//     logger.info(">>>>> Start 5 minute scheduled job");
//     initiateScheduledPointLogging(schedules.EVERY_5_MIN);
//     readAndLogWeather(schedules.EVERY_5_MIN);
// });
var s15 = schedule.schedule('0 */15 * * * *', function() {
    logger.info(">>>>> Start 15 minute scheduled job");
    initiateScheduledPointLogging(schedules.EVERY_15_MIN);
    readAndLogWeather(schedules.EVERY_15_MIN);
});
var s30 = schedule.schedule('5 */30 * * * *', function() {
    logger.info(">>>>> Start 30 minute scheduled job");
    initiateScheduledPointLogging(schedules.EVERY_30_MIN);
    readAndLogWeather(schedules.EVERY_30_MIN);
});

// var test4 = schedule.schedule('10 1 1,24 * * *', function() {
//     logger.info(">>>>> Start test job 5");
// });

// var s60 = schedule.schedule('30 0 */1 * * *', function() {
//     logger.info(">>>>> Start 60 minute scheduled job");
//     initiateScheduledPointLogging(schedules.EVERY_30_MIN);
//     readAndLogWeather(schedules.EVERY_60_MIN);
// });
var s12hr = schedule.schedule('10 0 0,12 * * *', function() {
    logger.info(">>>>> Start 12 Hr scheduled job");
    initiateScheduledPointLogging(schedules.EVERY_12_HR);
});

app.use(bodyParser.json()); // support JSON-encoded bodies
app.use(bodyParser.urlencoded({ // support URL-encoded bodies
    extended: true
}));

app.get('/config/:clientId', function(req, res) {
    var clientId = req.params.clientId;
    logger.debug(">>>>> Received GET /config/:clientId for clientId: " + clientId);
    res.send(JSON.stringify(config));
});

app.get('/log2minutepoints', function(req, res) {
    logger.info(">>>>> Manually triggered 2 minute points to be logged");
    initiateScheduledPointLogging(schedules.EVERY_2_MIN);
    readAndLogWeather(schedules.EVERY_2_MIN);
    res.sendStatus(200);
});
app.get('/log15minutepoints', function(req, res) {
    logger.info(">>>>> Manually triggered 15 minute points to be logged");
    initiateScheduledPointLogging(schedules.EVERY_15_MIN);
    readAndLogWeather(schedules.EVERY_15_MIN);
    res.sendStatus(200);
});
app.get('/log30minutepoints', function(req, res) {
    logger.info(">>>>> Manually triggered 30 minute points to be logged");
    initiateScheduledPointLogging(schedules.EVERY_30_MIN);
    readAndLogWeather(schedules.EVERY_30_MIN);
    res.sendStatus(200);
});
app.get('/log12hourpoints', function(req, res) {
    logger.info(">>>>> Manually triggered 12 hour points to be logged");
    initiateScheduledPointLogging(schedules.EVERY_12_HR);
    readAndLogWeather(schedules.EVERY_12_HR);
    res.sendStatus(200);
});

// port is currently set to 8081
app.listen(8081);

process.on('uncaughtException', function(err) {
    logger.error(err);
});

logger.warn("######################################################");
logger.warn("####                                              ####");
logger.warn("#### BIG Server Started - listening on port 8081 ####");
logger.warn("####                                              ####");
logger.warn("######################################################");

//var apiUsername = "admin";
//var apiPassword = "$uper$ecret";
//var jwtSecret = "$uper$ecret";

// app.use('/secure/logjobstatus', jsonParser, function(req, res) {
// 	//console.log('receieved /logjobstatus request');
// 	// Log data to Splunk
// 	splunkService.log(req.body, {index: "job_status", sourcetype: "collaterate"}, function(err, result) {
// 	     if (err) {
// 	    	 logSplunkError(">>>>> Error logging job status count to Splunk: ", err);
// 	     }
// 	 });
// 	res.sendStatus(200);
// });

//Secure all '/secure' routes with JWT
// app.use('/secure', expressJwt({secret: jwtSecret}));
//
// app.use('/authenticate', function (req, res) {
// 	  //console.log('receieved /authentication request');
// 	  if (!(req.body.username === apiUsername && req.body.password === apiPassword)) {
// 		  res.send(401, 'Wrong user or password');
// 		  return;
// 	  }
// 	  var profile = {
// 	    first_name: 'Collaterate',
// 	    last_name: 'Data'
// 	  };
// 	  var token = jwt.sign(profile, jwtSecret, { expiresInMinutes: 60*5000000 }); // basically never expire
// 	  res.json(token);
// });
