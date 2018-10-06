# awsLambdaRelay

This library provides a set of helper functions that makes it real easy to dynamically create an SQS queue, attach a Lambda listener and then tear it down afterwards to implement the _Relay Batch Design Pattern_.

Amazon limits the amount of time a Lambda can execute for, and as soon as the limit has been reached, the function is unceremonially terminated.  Therefore it is not suited for long running tasks.   But with a little consideration, you can make it work for long tasks.

### Problem Decomposition

1. For multi-tasks, break it up into multiple smaller units and distribute them for processing in parallel
1. For a task that can't be made parallel, do as much as you can before Lambda terminates, passing it over to the next Lambda call to continue processing.

### Examples

* Paging through SQL records
* Bulk API calls to an external service (for example SES, SalesForce etc) that can't be saturated with too many calls
* File import routines

The advantage of doing it programmatically is the reduced administration when it comes to creating and destroying queues with the associated coupling/decoupling of Lambda callbacks.

### Lambda Execution Limits

Currently, Amazon limits the execution time to:

* 30 seconds if triggered from the API Gateway
* 5 minutes for all other calls

## Installation

```
npm install mg-aws-lambda-relay
```

The API:

* .setup(context, lambdaFunc [,queueName])
* .getRelayPkt(event)
* .relayPass(relayPkt [,delaySeconds])
* .tearDown(relayPkt)


## Usage: Step 1; the setup

The first thing you need to do is to establish the relay.   This could be in response of an API Gateway call, passing in some job parameters of the task that has be to be completed.   This is a task that won't complete within the allocated 30 seconds that a Lambda is allowed to run for.

```
"use strict";

const awsRelay = require("mg-aws-lambda-relay");

module.exports = async (event, context, callback) => {

  // Setup the relay
  const lambdaFunc = "nameOfLambdaToProcessUnit";
  const relayPkt   = await awsRelay.setup( context, lambdaFunc );


  // Determine what is you are doing; use the relayPkt object to communicate
  // task details for the upstream Lambda calls
  relayPkt.s3FileToProcess = "/some/key/of/a/big/file.csv";


  // Pass it on to Lambda for processing
  // OR if you can process the units in parallel; then call .relayPass(.) multiple times
  await awsRelay.relayPass( relayPkt );
  
  
  callback(null, awsContext.ok(relayPkt));

}
```

## Usage: Step 2; the worker

Then for the Lambda that is listening for the relay messages, it will execute as much as it can within its time allocation and then pass it on to the next relay or terminate the overall relay.

```
"use strict";

const awsRelay = require("mg-aws-lambda-relay");
const { PerformanceObserver, performance } = require("perf_hooks");

module.exports = async (event, context, callback) => {

  // Get the relayPkt from the event
  const relayPkt = awsRelay.getRelayPkt(event);
  if ( relayPkt == null ){
    console.log("invalid relay message");
    return;
  }

  // Check to see if there is anything left to do;
  // if not:  await awsRelay.tearDown(relayPkt);


  // Loop around performing your task, small units/batches at a time
  let bStillTime = true;
  while ( bStillTime ){

    // Note the time we start
    const sTime = context.getRemainingTimeInMillis();


    // Perform the small unit of processing you need to do
    // doSomething();


    // Calculate how long it took
    const takenTime = performance.now() - stTime;

    // Determine if have enough time to execute another unit based on the
    // time it took for the last one (with a little buffer time added)
    if ( Math.ceil( takenTime + (takenTime * 0.5) ) > context.getRemainingTimeInMillis() ){
      await relayPass(relayPkt);
      bStillTime = false;
    }

  }

}
```

### Process flow: Single-Threaded Execution

You can think of it

```
+----------------+
|                |
|  Lambda-Start  |
|                |
+-------+--------+
        |
        | awsRelay.setup()
        | awsRelay.relayPass()
        v
+-------+--------+
|                |
|  Lambda-Worker |
|                |
+-------+--------+
        |
        |
        | awsRelay.relayPass()
        v
+-------+--------+
|                |
|  Lambda-Worker |
|                |
+-------+--------+
        |
        |
        | awsRelay.relayPass()
        v
+-------+--------+
|                |
|  Lambda-Worker |
|                |
+-------+--------+
        |
        |
        | awsRelay.tearDown()
        v
   +----+----+
```

### Process flow: Parallel Execution

If you can have your units run in parallel, then it is easy to use the same mechanism but instead of calling .relayPass() just once, you call it for each processing unit, setting some sort of parameter in the relayPkt to let the Lambda-Worker know which piece of the puzzle they are working on.

```
             +----------------+
             |                |
             |  Lambda-Start  |
             |                |
             +-------+--------+
                     |
                     | awsRelay.setup()
                     | awsRelay.relayPass()
                     | awsRelay.relayPass()
                     | awsRelay.relayPass()
                     v
+----------------+  ++---------------+  +----------------+
|                |  |                |  |                |
|  Lambda-Worker |  |  Lambda-Worker |  |  Lambda-Worker |
|                |  |                |  |                |
+----------------+  +----------------+  +----------------+
```

Note, depending on the number of units, under the covers Amazon may or may-not run them in parallel.  Given the nature of how Lamdba pulls messages off the SQS queue, then anything less than 10 will most likely result in a serial execution anyway.

### Permissions

The IAM role to which the Lambda function runs within needs the following permissions added (an example serverless.yml snippet).

```
iamRoleStatements:
  - Effect: "Allow"
    Action:
      - "sqs:*"
      - "lambda:CreateEventSourceMapping"
      - "lambda:DeleteEventSourceMapping"
```

### Notes

1. You can optionally delay the processing of the next relay by a maximum of 15minutes, by passing in the number of seconds to .relayPass()
1. You can use the relayPkt to pass custom data between your units; maximum size when serialized is 64KB
1. The SQS Queue will be setup under the same AWS Account and Region to which the setup Lambda is executing within
1. The Lambda function name is the logical name of the Lambda as seen in the Lambda console
1. You can override the queue name that is created by passing it in to .setup()

The relayPkt has the following makeup:

```
{
  "QueueUrl" : "",    // the underlying fully qualified SQS queue
  "UUID" : "",        // the UUID of the event-mapping for the Lambda
  "stats" : {         
    "sqsCount" : 0    // number of times the relayPass() has been called
  }

  // custom keys; anythig else you want to pass over
}
```

### Genesis

This came around when we were trying to send a large number of emails through Amazon SES which has its own limitations around saturation (14 emails/per second, 50k per day).  Wanted an elegant solution that didn't complicate the business logic but would take care of the backing-off of SES and try again if we gave it too much, as well as processing more than a single Lambda execution would permit.

### Feedback

Always welcome feedback and any additions.