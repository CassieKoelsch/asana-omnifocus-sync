#! /usr/bin/env node

const ASANA_ACCESS_TOKEN = "0/72eb99a4461ba70004ee3762372e293e";
const DEBUG = false;
const FORCE_CREATE_LOCAL = false;

const os = require("os");
var fs = require("fs-extra");
var asana = require("asana");
var applescript = require("applescript");
var moment = require("moment");

// Determine if OmniFocus is running
applescript.execString(
  'tell application "System Events" to (name of processes) contains "OmniFocus"',
  function(error, data, body) {
    if (data != "true") {
      if (DEBUG) console.log("OmniFocus not running");
      process.exit();
    }
  }
);

// Copy Applescripts
try {
  if (
    !fs.existsSync(os.homedir() + "/Library/Script Libraries/omnifocus.scpt")
  ) {
    fs.copySync(
      __dirname + "/node_modules/OmniFocus/OmniFocus Library/omnifocus.scpt",
      os.homedir() + "/Library/Script Libraries/omnifocus.scpt"
    );
  }
  if (!fs.existsSync(os.homedir() + "/Library/Script Libraries/json.scpt")) {
    fs.copySync(
      __dirname + "/node_modules/applescript-json/json.scpt",
      os.homedir() + "/Library/Script Libraries/json.scpt"
    );
  }
} catch (error) {
  console.log("Could not copy file: ", error);
}

var client = asana.Client.create().useAccessToken(ASANA_ACCESS_TOKEN);

function createLocalTask(task) {
  if (DEBUG) console.log("Creating local task for: " + task.name);
  if (!FORCE_CREATE_LOCAL && task.external && task.external.gid) {
    if (DEBUG) console.log("Task " + task.gid + " already linked");
    return false;
  } else if (task.completed) {
    if (DEBUG) console.log("Task " + task.gid + " already completed, skipping");
    return true;
  }

  applescript.execFile(
    __dirname + "/applescripts/createTask.applescript",
    [
      //transportText
      task.name,
      task.projects && task.projects[0] ? task.projects[0].name : "-",
      task.projects && task.projects[0] && task.projects[0].section
        ? task.projects[0].section.name
        : "-",
      task.due_on
        ? moment(task.due_on + (task.due_at ? " " + task.due_at : "")).format(
            "YYYY-MM-DD" + (task.due_at ? " HH:mm:ss" : "")
          )
        : "-",
      task.notes ? task.notes : "-"
    ],
    function(error, data, body) {
      if (typeof data == "string") {
        var taskId = data;
        if (DEBUG == "verbose") console.log("Local task created: " + taskId);
        linkAsanaTask(task.gid, taskId);
      } else {
        console.log("Local task not created.", error, body);
      }
    }
  );
}

function updateLocalTask(task) {
  if (DEBUG) console.log("Updating local task: " + task.name);
  if (!task.external || !task.external.gid) return false;

  var localId = task.external.gid;

  var parameters = [
    localId,
    task.name ? task.name : "-",
    task.completed ? "true" : "false",
    task.due_on
      ? moment(task.due_on + (task.due_at ? " " + task.due_at : "")).format(
          "YYYY-MM-DD" + (task.due_at ? " HH:mm:ss" : "")
        )
      : "-",
    task.notes ? task.notes : "-"
  ];

  applescript.execFile(
    __dirname + "/applescripts/updateTask.applescript",
    parameters,
    function(error, data, body) {
      if (!error) {
        if (DEBUG == "verbose") console.log("Local task updated.");
      } else {
        console.log("Local task not updated.", error);
      }
    }
  );
}

function getLocalTaskData(id, callback, secondTry) {
  if (DEBUG == "verbose") console.log("Getting local task data: " + id);
  applescript.execFile(
    __dirname + "/applescripts/getTaskData.applescript",
    [id],
    function(error, data, body) {
      try {
        var parsedData = JSON.parse(data);
      } catch (error) {
        if (!secondTry) {
          if (DEBUG == "verbose")
            console.log(
              "Invalid JSON Data for task ID " + id + ", trying again..."
            );
          getLocalTaskData(id, callback, true);
        } else {
          console.log("Invalid JSON Data for task ID " + id, data, body);
        }
        return false;
      }

      if (secondTry) {
        if (DEBUG == "verbose")
          console.log("Second try success for task ID " + id);
      }

      var df = "dddd, MMMM D, YYYY [at] h:mm:ss A";

      parsedData.due_on =
        parsedData.due_on.length > 0 && parsedData.due_on != "missing value"
          ? moment(parsedData.due_on, df)
          : null;
      parsedData.created =
        parsedData.created.length > 0 && parsedData.created != "missing value"
          ? moment(parsedData.created, df)
          : null;
      parsedData.modified =
        parsedData.modified.length > 0 && parsedData.modified != "missing value"
          ? moment(parsedData.modified, df)
          : null;

      callback(parsedData);
    }
  );
}

function updateRemoteTask(task, localData) {
  if (DEBUG) console.log("Updating remote task for: " + localData.name);
  if (!task.external || !task.external.gid || !localData || !localData.name)
    return false;

  var parameters = {
    name: localData.name,
    completed: localData.completed
  };

  if (localData.due_on) {
    parameters.due_on = localData.due_on.format("YYYY-MM-DD");
  }

  if (localData.notes && localData.notes.length > 0) {
    parameters.notes = localData.notes;
  }

  client.tasks
    .update(task.gid, parameters)
    .then(function(response) {})
    .catch(function(error) {
      console.log("Could not update remote task " + task.gid);
    });
}

function linkAsanaTask(asanaId, omnifocusId) {
  console.log(asanaId);
  if (DEBUG == "verbose")
    console.log("Linking asana ID " + asanaId + " with OF ID " + omnifocusId);
  client.tasks
    .update(asanaId, {
      external: { id: omnifocusId }
    })
    .then(function(response) {})
    .catch(function(error) {
      console.log("Could not link Asana task " + asanaId);
    });
}

function processLinkedTask(task) {
  if (DEBUG == "verbose") console.log("Processing linked task: " + task.name);
  if (!task.external || !task.external.gid) return false;

  var modifiedOnAsana = moment(task.modified_at);

  getLocalTaskData(task.external.gid, function(localData) {
    if (
      task.name == localData.name &&
      task.completed == localData.completed &&
      ((task.due_on && localData.due_on) ||
        (!task.due_on && !localData.due_on)) &&
      (!task.due_on ||
        moment(task.due_on)
          .startOf("day")
          .isSame(localData.due_on.startOf("day"))) &&
      task.notes == localData.notes
    ) {
      if (DEBUG == "verbose") console.log("Data is the same, skipping");
      return true;
    }

    var modifiedLocally = localData.modified;

    if (modifiedOnAsana.isBefore(modifiedLocally)) {
      // Trust local
      updateRemoteTask(task, localData);
    } else {
      // Trust remote
      updateLocalTask(task);
    }
  });
}

var created = 0;
var updated = 0;

function processCollection(collection) {
  collection.data.forEach(task => processTask(task));

  collection
    .nextPage()
    .then(collection => processCollection(collection))
    .catch(function(error) {
      if (DEBUG == "verbose") console.log("Paging complete");
    });
}

function processTask(task) {
  if (!FORCE_CREATE_LOCAL && task.external && task.external.gid) {
    processLinkedTask(task);
    updated++;
  } else {
    createLocalTask(task);
    created++;
  }
}

client.users
  .me()
  .then(function(user) {
    var userId = user.gid;
    var workspaceId = user.workspaces[0].gid;

    return client.tasks.findAll({
      assignee: userId,
      workspace: workspaceId,
      completed_since: moment()
        .subtract(1, "month")
        .format(),
      opt_fields:
        "id,name,assignee_status,completed,due_on,due_at,external,modified_at,notes,projects,projects.name,projects.section,projects.section.name,parent"
    });
  })
  .then(processCollection)
  .catch(function(error) {
    console.log("Error: ", error);
  });

process.on("exit", function() {
  if (created + updated > 0) {
    console.log(
      "Processed " +
        (created + updated) +
        " remote tasks (" +
        created +
        " new; " +
        updated +
        " existing)"
    );
  }
});
